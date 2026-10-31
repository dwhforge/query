#!/usr/bin/env python3
"""Load KeyMap example fixtures into PostgreSQL schema keymap_demo.

Default lab (override with DWH_PG_DSN):
  postgresql://postgres:postgres@localhost:5432/dwh_tests

  python scripts/examples/generate_all.py
  python scripts/examples/load_postgres.py

DuckDB CLI + ATTACH. Uses CREATE … LIMIT 0 then INSERT — full CTAS into
Postgres via ATTACH often leaves tables empty after the first.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
import urllib.parse as up
from pathlib import Path

DEFAULT_DSN = "postgresql://postgres:postgres@localhost:5432/dwh_tests"
SCHEMA = "keymap_demo"

TABLES = [
    ("crosswalk/pos_sales.csv", "pos_sales"),
    ("crosswalk/wms_moves.csv", "wms_moves"),
    ("crosswalk/map_pos_to_wms.csv", "map_pos_to_wms"),
    ("dual/dim_party.csv", "dim_party"),
    ("dual/pos_covers.csv", "pos_covers"),
    ("dual/ap_invoices.csv", "ap_invoices"),
    ("dual/map_sales_alias_pg.csv", "map_sales_alias"),
    ("dual/map_spend_alias_pg.csv", "map_spend_alias"),
    ("codes/ecommerce_sales.csv", "ecommerce_sales"),
    ("codes/map_channel_pg.csv", "map_channel"),
    ("hop/store_sales.csv", "store_sales"),
    ("hop/dim_region.csv", "dim_region"),
    ("hop/map_store_to_region.csv", "map_store_to_region"),
    ("hop/map_region_to_country.csv", "map_region_to_country"),
]


def sqlstr(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def build_sql(data: Path, schema: str, dsn: str) -> str:
    lines = [
        "INSTALL postgres; LOAD postgres;",
        f"ATTACH {sqlstr(dsn)} AS pg (TYPE postgres);",
        f"CALL postgres_execute('pg', {sqlstr(f'CREATE SCHEMA IF NOT EXISTS \"{schema}\"')});",
    ]
    for rel, table in TABLES:
        path = (data / rel).resolve()
        if not path.is_file():
            raise SystemExit(f"missing {path} — run generate_all.py first")
        csv = sqlstr(path.as_posix())
        fq = f'pg."{schema}"."{table}"'
        lines += [
            f"CALL postgres_execute('pg', {sqlstr(f'DROP TABLE IF EXISTS \"{schema}\".\"{table}\" CASCADE')});",
            f"CREATE TABLE {fq} AS SELECT * FROM read_csv_auto({csv}) LIMIT 0;",
            f"INSERT INTO {fq} SELECT * FROM read_csv_auto({csv});",
            f"SELECT '{schema}.{table}' AS tbl, COUNT(*)::BIGINT AS n FROM {fq};",
        ]
    return "\n".join(lines)


def psql_counts(dsn: str, schema: str) -> list[tuple[str, int]]:
    psql = shutil.which("psql")
    if not psql:
        return []
    u = up.urlparse(dsn)
    env = os.environ.copy()
    if u.password:
        env["PGPASSWORD"] = up.unquote(u.password)
    out: list[tuple[str, int]] = []
    for _, table in TABLES:
        r = subprocess.run(
            [
                psql,
                "-h",
                u.hostname or "localhost",
                "-p",
                str(u.port or 5432),
                "-U",
                up.unquote(u.username or "postgres"),
                "-d",
                (u.path or "/dwh_tests").lstrip("/") or "dwh_tests",
                "-At",
                "-c",
                f'SELECT COUNT(*) FROM "{schema}"."{table}";',
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        if r.returncode != 0:
            raise SystemExit(r.stderr or f"psql failed for {table}")
        out.append((table, int((r.stdout or "0").strip() or "0")))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--data",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "fixtures" / "examples",
    )
    ap.add_argument("--schema", default=SCHEMA)
    args = ap.parse_args()
    dsn = os.environ.get("DWH_PG_DSN", DEFAULT_DSN).strip()
    sql = build_sql(args.data, args.schema, dsn)

    duckdb_bin = shutil.which("duckdb")
    if not duckdb_bin:
        raise SystemExit("Need `duckdb` on PATH to load Postgres")

    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
        tf.write(sql)
        tf_path = tf.name
    print(f"loading via {duckdb_bin} → schema {args.schema}")
    proc = subprocess.run(
        [duckdb_bin, "-c", f".read {tf_path}"],
        capture_output=True,
        text=True,
    )
    Path(tf_path).unlink(missing_ok=True)
    if proc.returncode != 0:
        proc = subprocess.run(
            [duckdb_bin, "-c", sql],
            capture_output=True,
            text=True,
        )
    print(proc.stdout)
    if proc.stderr.strip():
        print(proc.stderr, end="")
    if proc.returncode != 0:
        raise SystemExit(proc.stderr or f"duckdb exit {proc.returncode}")

    counts = psql_counts(dsn, args.schema)
    if counts:
        print("psql COUNT(*):")
        bad = []
        for table, n in counts:
            print(f"  {args.schema}.{table}: {n}")
            if n == 0:
                bad.append(table)
        if bad:
            raise SystemExit(f"empty tables after load: {', '.join(bad)}")

    print(f"done — {dsn.split('@')[-1]}")


if __name__ == "__main__":
    main()
