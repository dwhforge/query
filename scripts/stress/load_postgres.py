#!/usr/bin/env python3
"""Load stress parquet tables into PostgreSQL and emit an identical DWH project.

The workspace graph (queries, joins, key map, outputs, canvas) matches the
parquet project; only LoadParquet → LoadPostgres + sources change.

  export STRESS_PG_DSN='postgresql://user:pass@127.0.0.1:5432/postgres'
  python scripts/stress/load_postgres.py \
    --data /app2/stress-test/100k \
    --schema stress \
    --connection-id conn_postgres

DSN is read from the environment only (never argv). Resume skips tables that
already have the expected row count from manifest.json.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import time
from pathlib import Path

TABLES = [
    "production_catalog",
    "commercial_catalog",
    "sales",
    "production_batches",
    "production_operations",
    "quality_measurements",
    "shipment_allocations",
    "commercial_adjustments",
    "customers",
]


def sqlstr(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def load_manifest(data: Path) -> dict:
    mf = data / "manifest.json"
    if not mf.is_file():
        raise SystemExit(f"missing {mf}")
    return json.loads(mf.read_text())


def expected_rows(manifest: dict, table: str) -> int | None:
    total = 0
    found = False
    for rel, meta in manifest.get("parts", {}).items():
        if rel.startswith(table + "/"):
            total += int(meta["rows"])
            found = True
    return total if found else None


def parquet_glob(data: Path, table: str) -> str:
    return str(data / table / "*.parquet")


def attach_postgres(con, dsn: str) -> None:
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH {sqlstr(dsn)} AS pg (TYPE postgres)")


def pg_count(con, schema: str, table: str) -> int | None:
    q = f"""
    SELECT COUNT(*)::BIGINT FROM postgres_query('pg',
      {sqlstr(f'SELECT COUNT(*)::BIGINT AS c FROM "{schema}"."{table}"')})
    """
    try:
        return int(con.execute(q).fetchone()[0])
    except Exception:
        return None


def ensure_schema(con, schema: str) -> None:
    con.execute(
        f"CALL postgres_execute('pg', {sqlstr(f'CREATE SCHEMA IF NOT EXISTS \"{schema}\"')})"
    )


def drop_table(con, schema: str, table: str) -> None:
    con.execute(
        f"CALL postgres_execute('pg', {sqlstr(f'DROP TABLE IF EXISTS \"{schema}\".\"{table}\" CASCADE')})"
    )


def create_as_select(con, schema: str, table: str, parquet_path: str) -> None:
    # Create empty table from parquet schema, then INSERT — more resilient than CTAS for huge sets.
    con.execute(
        f"""
        CREATE TABLE pg."{schema}"."{table}" AS
        SELECT * FROM read_parquet({sqlstr(parquet_path)}) LIMIT 0
        """
    )
    con.execute(
        f"""
        INSERT INTO pg."{schema}"."{table}"
        SELECT * FROM read_parquet({sqlstr(parquet_path)})
        """
    )


def rewrite_project(
    src_project: dict,
    *,
    connection_id: str,
    schema: str,
    out_path: Path,
) -> dict:
    """Clone parquet stress project → identical graph with Postgres loads."""
    proj = copy.deepcopy(src_project)
    proj["id"] = "stress_product_commercial_pg"
    proj["name"] = "stress_product_commercial_pg"
    # Keep engine duckdb for preview federation via postgres scanner; destination optional PG.
    proj["execution_engine"] = proj.get("execution_engine") or "duckdb"
    proj["target_dialect"] = proj.get("target_dialect") or "duckdb"

    sources = []
    for table in TABLES:
        sources.append(
            {
                "id": table,
                "name": table,
                "kind": "postgres",
                "connection_id": connection_id,
                "schema": schema,
                "table_name": table,
            }
        )
    proj["sources"] = sources

    for q in proj["workspace"]["queries"]:
        steps = q.get("steps") or []
        if not steps:
            continue
        s0 = steps[0]
        if s0.get("type") == "LoadParquet":
            table = q["id"]
            if table not in TABLES:
                raise SystemExit(f"LoadParquet query id {table!r} not in TABLES")
            steps[0] = {
                "type": "LoadPostgres",
                "payload": {
                    "connection_id": connection_id,
                    "schema": schema,
                    "table_name": table,
                },
            }
        # Keep DeriveColumn duckdb dialect — preview stays on DuckDB engine.
    out_path.write_text(json.dumps(proj, indent=2) + "\n")
    return proj


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", type=Path, required=True, help="stress data dir with parquet + stress.dwhproj.json")
    p.add_argument("--schema", default="stress")
    p.add_argument("--connection-id", default="conn_postgres")
    p.add_argument("--dsn-env", default="STRESS_PG_DSN")
    p.add_argument("--memory", default="6GB")
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--project-out", type=Path, default=None)
    p.add_argument("--skip-load", action="store_true", help="only rewrite .dwhproj.json")
    p.add_argument("--force", action="store_true", help="drop+reload tables even if counts match")
    a = p.parse_args()

    data = a.data.resolve()
    src_proj_path = data / "stress.dwhproj.json"
    if not src_proj_path.is_file():
        raise SystemExit(f"missing {src_proj_path}")
    src_proj = json.loads(src_proj_path.read_text())
    project_out = a.project_out or (data / "stress_pg.dwhproj.json")

    rewrite_project(
        src_proj,
        connection_id=a.connection_id,
        schema=a.schema,
        out_path=project_out,
    )
    print(f"PROJECT: {project_out}", flush=True)

    if a.skip_load:
        print("skip-load: project only")
        return

    dsn = os.environ.get(a.dsn_env, "").strip()
    if not dsn:
        raise SystemExit(
            f"Set {a.dsn_env} to a PostgreSQL URI (password not accepted on argv).\n"
            f"Example: export {a.dsn_env}='postgresql://user:pass@127.0.0.1:5432/postgres'"
        )

    try:
        import duckdb
    except ImportError as e:
        raise SystemExit(
            "Python duckdb package required for load. "
            "Use the stress venv or: pip install duckdb"
        ) from e

    manifest = load_manifest(data)
    con = duckdb.connect()
    con.execute(f"SET memory_limit={sqlstr(a.memory)}")
    con.execute(f"SET threads={a.threads}")
    con.execute("SET preserve_insertion_order=false")
    attach_postgres(con, dsn)
    ensure_schema(con, a.schema)

    for table in TABLES:
        expect = expected_rows(manifest, table)
        glob = parquet_glob(data, table)
        if not list((data / table).glob("*.parquet")):
            raise SystemExit(f"no parquet under {data / table}")
        have = pg_count(con, a.schema, table)
        if (
            not a.force
            and expect is not None
            and have is not None
            and have == expect
        ):
            print(f"SKIP {table}: already {have:,} rows", flush=True)
            continue
        print(f"LOAD {table}: expect={expect} have={have} …", flush=True)
        t0 = time.perf_counter()
        drop_table(con, a.schema, table)
        create_as_select(con, a.schema, table, glob)
        got = pg_count(con, a.schema, table)
        dt = time.perf_counter() - t0
        print(f"DONE {table}: {got:,} rows in {dt:.1f}s", flush=True)
        if expect is not None and got != expect:
            raise SystemExit(f"row count mismatch for {table}: got {got} expected {expect}")

    print(f"READY: schema={a.schema} project={project_out}")
    print(f"Open {project_out} in DWH Query (connection id={a.connection_id}).")


if __name__ == "__main__":
    main()
