#!/usr/bin/env python3
"""Verify the user's saved DWH project, actual exported seed, and published marts.
Uses oracle only here; never populates the app KeyMap or its dbt seed.
"""
import argparse
import csv
import json
import os
from pathlib import Path
import duckdb
from base_generator import sqlstr


def rows(path):
    with open(path,newline='',encoding='utf-8') as f:return list(csv.DictReader(f))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,required=True)
    p.add_argument('--project',type=Path,required=True,help='Project saved FROM DWH Query after accepting fuzzy')
    p.add_argument('--export',dest='export_root',type=Path,required=True,help='Directory containing dbt_project.yml')
    p.add_argument('--duckdb',type=Path,help='Published DuckDB file; default export/local.duckdb')
    p.add_argument('--pg-env',help='Name of environment variable holding destination DSN (not the DSN itself)')
    p.add_argument('--schema',default='public');p.add_argument('--memory',default='4GB');a=p.parse_args()
    data=a.data.resolve();(data/'verification.json').unlink(missing_ok=True)
    project=json.loads(a.project.read_text());manifest=json.loads((data/'manifest.json').read_text())
    oracle={r['from']:r['to'] for r in rows(data/'_oracle'/'expected_map.csv')}
    mapping=next(m for m in project['workspace']['key_maps'] if m['id']=='map_commercial_to_production')
    def check_map(entries,label):
        got={r['from']:r['to'] for r in entries}
        if len(got)!=len(entries) or got!=oracle:raise RuntimeError(f'{label}: incomplete/incorrect mapping ({len(got)} unique / {len(oracle)} expected)')
    check_map(mapping['entries'],'Saved project')
    check_map(rows(a.export_root/'seeds'/'map_commercial_to_production.csv'),'Exported seed')
    c=duckdb.connect();c.execute(f'SET memory_limit={sqlstr(a.memory)}')
    if a.pg_env:
        dsn=os.environ.get(a.pg_env)
        if not dsn:raise SystemExit('DSN environment variable is empty')
        c.execute(f'ATTACH {sqlstr(dsn)} AS actual (TYPE postgres, READ_ONLY)')
        schema='"'+a.schema.replace('"','""')+'"'
    else:
        f=(a.duckdb or a.export_root/'local.duckdb').resolve()
        c.execute(f'ATTACH {sqlstr(f)} AS actual (READ_ONLY)');schema='main'
    all_rel=f'actual.{schema}.mart_monthly_all';final_rel=f'actual.{schema}.mart_monthly_product_margin'
    # Checks run against actual destination data, not a rerun of the pipeline.
    actual=c.execute(f'SELECT sum(sales_lines),sum(sold_kg),sum(net_revenue),sum(unmapped_lines) FROM {all_rel}').fetchone()
    expected=c.execute(f"SELECT count(*),sum(quantity_kg),sum(quantity_kg*unit_price) FROM read_parquet({sqlstr(data/'sales'/'*.parquet')})").fetchone()
    adjustment=c.execute(f"SELECT sum(adjustment) FROM read_parquet({sqlstr(data/'commercial_adjustments'/'*.parquet')})").fetchone()[0]
    if tuple(actual[:3])!=(expected[0],expected[1],expected[2]+adjustment) or actual[3]!=0:
        raise RuntimeError(f'Conservation/coverage failed: actual={actual}, expected={(expected[0],expected[1],expected[2]+adjustment,0)}')
    final_count,bad=c.execute(f'SELECT count(*),count(*) FILTER(WHERE name IS NULL OR customer_name IS NULL OR unmapped_lines<>0 OR product_flagged_kg<=product_allocated_kg*0.03 OR net_revenue-production_cost>=net_revenue*0.10) FROM {final_rel}').fetchone()
    if bad:raise RuntimeError(f'{bad} final rows violate report predicates')
    # Independent total cost check: aggregate production events and allocation kg.
    expected_cost=c.execute(f"""WITH cost AS (
      SELECT batch_id,sum(resource_cost) AS cost FROM read_parquet({sqlstr(data/'production_operations'/'*.parquet')}) GROUP BY batch_id
    ), qty AS (
      SELECT batch_id,sum(allocated_kg) AS kg FROM read_parquet({sqlstr(data/'shipment_allocations'/'*.parquet')}) GROUP BY batch_id
    ) SELECT sum(q.kg*coalesce(c.cost,0)/b.output_kg)
    FROM qty q JOIN read_parquet({sqlstr(data/'production_batches'/'*.parquet')}) b USING(batch_id)
    LEFT JOIN cost c USING(batch_id)""").fetchone()[0]
    actual_cost=c.execute(f'SELECT sum(production_cost) FROM {all_rel}').fetchone()[0]
    if abs(float(actual_cost)-float(expected_cost))>max(.01,abs(float(expected_cost))*1e-9):raise RuntimeError('Production cost conservation failed')
    if not final_count:raise RuntimeError('Final mart is empty; fixture/report must produce eligible products')
    result={'ok':True,'products':len(oracle),'sales_rows':expected[0], 'revenue':str(actual[2]),
            'production_cost':str(actual_cost),'final_rows':final_count,'duckdb_version':duckdb.__version__,
            'data_bytes':manifest['total_bytes'],'checks':['project_map','export_seed','row_count','quantity','revenue','mapping_coverage','cost','report_predicates','nonempty_output']}
    (data/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));c.close()

if __name__=='__main__':main()
