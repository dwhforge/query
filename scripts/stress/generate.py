#!/usr/bin/env python3
"""Generate local test inputs + an EMPTY-KeyMap DWH Query project. No mapping is prefilled.
python generate.py --out /path/to/ssd/stress --sales-rows 1000000 --products 100000
"""
import argparse
import csv
import json
import os
from pathlib import Path
import time
import duckdb
from base_generator import h, sqlstr, save_json


def code(expr, side):
    # Independent, collision-free permutations in the permitted <=100K catalog.
    factor, offset, prefix = (7919, 113, 'TECH-') if side=='production' else (15427, 791, 'SKU-')
    return f"'{prefix}'||lpad(CAST((({expr})*{factor}+{offset})%1000003 AS VARCHAR),7,'0')"


def specifications(n,k,payload,seed):
    bpp=max(1,n//(4*k)); batches=k*bpp
    label="(['Arabica','Robusta','Cocoa','Oat','Almond','Tea','Berry','Vanilla'])[(1+i%8)::INTEGER]"
    production=f"SELECT {code('i','production')} AS product_code, 'Recipe '||lpad(CAST(i AS VARCHAR),6,'0')||' '||{label}||' premium blend 500g' AS name FROM range({{lo}},{{hi}}) t(i)"
    commercial=f"SELECT {code('i','commercial')} AS commercial_code, 'Receipe '||lpad(CAST(i AS VARCHAR),6,'0')||' '||{label}||' premium blend 500 g' AS name FROM range({{lo}},{{hi}}) t(i)"
    pid=f"(1+{h('i','sale-product',seed)}%{k})::BIGINT"
    qty=f"(10+{h('i','sale-qty',seed)}%91)::INTEGER"
    texts=' || '.join(f"sha256(CAST(i AS VARCHAR)||':{seed}:payload:{s}')" for s in range((payload+63)//64)) or "''"
    attributes=', '.join(f"({h('i',f'attr-{a}',seed)}%10000)::INTEGER AS attribute_{a:02}" for a in range(1,32))
    sales=f"""WITH x AS (SELECT i,{pid} AS pid FROM range({{lo}},{{hi}}) t(i))
      SELECT i AS sale_line_id,{code('pid','commercial')} AS commercial_code,
      (1+{h('i','customer',seed)}%1000000)::BIGINT AS customer_id,
      (1+{h('i','market',seed)}%30)::INTEGER AS market_id,
      (['USD','EUR','CNY','RUB'])[(1+{h('i','currency',seed)}%4)::INTEGER] AS contract_currency,
      DATE '2024-01-01'+({h('i','action',seed)}%731)::INTEGER AS action_date,
      {qty} AS quantity_kg, ((200+{h('i','price',seed)}%800)/100.0)::DECIMAL(18,2) AS unit_price,
      {attributes},substr({texts},1,{payload}) AS audit_payload FROM x"""
    batch=f"""WITH x AS (SELECT i,(i-1)//{bpp}+1 AS pid FROM range({{lo}},{{hi}}) t(i))
      SELECT i AS batch_id,{code('pid','production')} AS product_code,
      (100+{h('i','output',seed)}%901)::DECIMAL(18,3) AS output_kg,
      (1+{h('i','plant',seed)}%50)::INTEGER AS plant_id FROM x"""
    # 70% of operations go to the hot 5% of batches; all batches still exist.
    hot=max(1,batches//20)
    batch_id=f"(CASE WHEN {h('i','hot',seed)}%10<7 THEN 1+{h('i','batchhot',seed)}%{hot} ELSE 1+{h('i','batchcold',seed)}%{batches} END)::BIGINT"
    ops=f"SELECT i AS operation_id,{batch_id} AS batch_id,((100+{h('i','cost',seed)}%10000)/100.0)::DECIMAL(18,2) AS resource_cost FROM range({{lo}},{{hi}}) t(i)"
    qa=f"""WITH x AS (SELECT i,(1+{h('i','qualitybatch',seed)}%{batches})::BIGINT AS batch_id FROM range({{lo}},{{hi}}) t(i))
      SELECT i AS measurement_id,batch_id,({h('batch_id','qualityflag',seed)}%10=0)::INTEGER AS outside_spec FROM x"""
    # Two allocations per sales line, both from the correct product's batches.
    alloc=f"""WITH x AS (SELECT i,(i-1)//2+1 AS sid,(i-1)%2 AS leg FROM range({{lo}},{{hi}}) t(i)),
      y AS (SELECT *, (1+{h('sid','sale-product',seed)}%{k})::BIGINT AS pid,
      (10+{h('sid','sale-qty',seed)}%91)::INTEGER AS qty FROM x)
      SELECT i AS allocation_id,sid AS sale_line_id,
      ((pid-1)*{bpp}+1+({h('sid','allocationbatch',seed)}+leg)%{bpp})::BIGINT AS batch_id,
      (qty*CASE WHEN leg=0 THEN 6 ELSE 4 END/10.0)::DECIMAL(18,3) AS allocated_kg FROM y"""
    adj=f"SELECT i AS adjustment_id,(1+{h('i','adj-sale',seed)}%{n})::BIGINT AS sale_line_id,(-(({h('i','adj-amount',seed)}%10000)::BIGINT)/100.0)::DECIMAL(18,2) AS adjustment FROM range({{lo}},{{hi}}) t(i)"
    customers="SELECT i AS customer_id,'Customer '||CAST(i AS VARCHAR) AS customer_name FROM range({lo},{hi}) t(i)"
    return {'production_catalog':(k,production),'commercial_catalog':(k,commercial),
      'sales':(n,sales),'production_batches':(batches,batch),'production_operations':(3*n,ops),
      'quality_measurements':(2*n,qa),'shipment_allocations':(2*n,alloc),
      'commercial_adjustments':(max(1,n//10),adj),'customers':(1000000,customers)}


def step(kind,**p):return {'type':kind,'payload':p}


def make_project(out):
    queries=[]
    def q(name,steps):
        flat=[s for item in steps for s in (item if isinstance(item,list) else [item])]
        queries.append({'id':name,'name':name,'steps':flat,'execution':'local'})
    def source(name):q(name,[step('LoadParquet',path=str(out/name/'*.parquet'))])
    def frm(name):return step('FromQuery',query_id=name)
    def join(name,*keys):return step('Join',right_query_id=name,join_type='left',left_on=list(keys),right_on=list(keys))
    def group(keys,*aggs):
        # Explicit output columns keep chained Join schemas known in the current IR.
        cols=keys+[a.rsplit(' AS ',1)[1] for a in aggs]
        return [step('GroupBy',dimensions=keys,aggregates=list(aggs)),step('SelectColumns',columns=cols)]
    for name in ['production_catalog','commercial_catalog','sales','production_batches','production_operations','quality_measurements','shipment_allocations','commercial_adjustments','customers']:source(name)
    q('batch_resources',[frm('production_operations'),group(['batch_id'],'SUM(resource_cost) AS resource_cost')])
    q('batch_quality',[frm('quality_measurements'),group(['batch_id'],'MAX(outside_spec) AS outside_spec')])
    q('batch_cost',[frm('production_batches'),join('batch_resources','batch_id'),join('batch_quality','batch_id'),
       step('DeriveColumn',name='unit_cost',mode='sql',sql_dialect='duckdb',expression='COALESCE(resource_cost,0) / output_kg')])
    q('costed_allocations',[frm('shipment_allocations'),join('batch_cost','batch_id')])
    q('line_costs',[frm('costed_allocations'),group(['sale_line_id','product_code'],
       'SUM(allocated_kg * unit_cost) AS production_cost','SUM(allocated_kg) AS allocated_kg',
       'SUM(CASE WHEN outside_spec=1 THEN allocated_kg ELSE 0 END) AS flagged_kg')])
    q('line_adjustments',[frm('commercial_adjustments'),group(['sale_line_id'],'SUM(adjustment) AS adjustment')])
    q('sales_mapped',[frm('sales'),step('ApplyKeyMap',column='commercial_code',map_id='map_commercial_to_production',entries=[]),
       step('RenameColumn',**{'from':'commercial_code','to':'product_code'})])
    q('reconciled_sales',[frm('sales_mapped'),join('line_costs','sale_line_id','product_code'),join('line_adjustments','sale_line_id'),
       step('DeriveColumn',name='sales_month',mode='sql',sql_dialect='duckdb',expression="date_trunc('month', action_date)::DATE"),
       step('DeriveColumn',name='net_revenue',mode='sql',sql_dialect='duckdb',expression='quantity_kg * unit_price + COALESCE(adjustment,0)')])
    q('product_quality',[frm('line_costs'),group(['product_code'],'SUM(allocated_kg) AS product_allocated_kg','SUM(flagged_kg) AS product_flagged_kg'),
       step('Filter',condition='product_flagged_kg > product_allocated_kg * 0.03')])
    q('monthly_all',[frm('reconciled_sales'),group(['sales_month','product_code','customer_id','contract_currency','market_id'],
       'COUNT(*) AS sales_lines','SUM(quantity_kg) AS sold_kg','SUM(net_revenue) AS net_revenue',
       'SUM(production_cost) AS production_cost','SUM(flagged_kg) AS flagged_kg',
       'COUNT(*) FILTER(WHERE production_cost IS NULL) AS unmapped_lines')])
    q('monthly_product_margin',[frm('monthly_all'),join('product_quality','product_code'),
       step('Filter',condition='product_allocated_kg IS NOT NULL AND unmapped_lines=0 AND net_revenue-production_cost < net_revenue*0.10'),
       join('production_catalog','product_code'),join('customers','customer_id'),
       step('DeriveColumn',name='margin',mode='sql',sql_dialect='duckdb',expression='net_revenue-production_cost')])
    return {'id':'stress_product_commercial','name':'stress_product_commercial','connections':[],
      'sources':[{'id':q['id'],'name':q['name'],'kind':'parquet','path':q['steps'][0]['payload']['path']} for q in queries if q['steps'][0]['type']=='LoadParquet'],
      'workspace':{'queries':queries,'focus_query_id':'commercial_catalog','key_maps':[{'id':'map_commercial_to_production',
      'name':'Commercial → Production (fill with batch fuzzy)','entries':[],'storage':{'kind':'seed'},'from_column':'from','to_column':'to'}]},
      'dbt_target':'v1','execution_engine':'duckdb','target_dialect':'duckdb','destination':{'kind':'duckdb','duckdb_path':'local.duckdb','schema':'public'},
      'outputs':['monthly_all','monthly_product_margin'],'materialization':'table',
      'canvas':{'positions':{q['id']:{'x':(i%4)*320,'y':(i//4)*170} for i,q in enumerate(queries)}}}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True);p.add_argument('--sales-rows',type=int,default=1000000)
    p.add_argument('--products',type=int,default=100000);p.add_argument('--chunk-rows',type=int,default=500000)
    p.add_argument('--threads',type=int,default=4);p.add_argument('--memory',default='4GB')
    p.add_argument('--seed',type=int,default=42);p.add_argument('--payload-bytes',type=int,default=256)
    p.add_argument('--resume',action='store_true');a=p.parse_args()
    if not 100<=a.products<=100000 or a.sales_rows<1000 or a.chunk_rows<1 or a.threads<1 or a.payload_bytes<0:p.error('products 100..100000; sales-rows >=1000; chunk/threads positive; payload >=0')
    out=a.out.resolve();cfg={**vars(a),'out':str(out),'resume':False,'duckdb_version':duckdb.__version__,'generator_version':1};mf=out/'manifest.json'
    if mf.exists():
        state=json.loads(mf.read_text());
        if not a.resume or state['config']!=cfg:p.error('Use --resume with identical generation options, or a new output directory')
    else:
        if out.exists() and any(out.iterdir()):p.error('Output must be empty')
        out.mkdir(parents=True,exist_ok=True);state={'config':cfg,'parts':{}};save_json(mf,state)
    c=duckdb.connect();c.execute(f'SET threads={a.threads}');c.execute(f'SET memory_limit={sqlstr(a.memory)}');c.execute('SET preserve_insertion_order=false')
    for name,(count,sql) in specifications(a.sales_rows,a.products,a.payload_bytes,a.seed).items():
        (out/name).mkdir(exist_ok=True)
        for part,lo in enumerate(range(1,count+1,a.chunk_rows)):
            hi=min(lo+a.chunk_rows,count+1);f=out/name/f'part-{part:05}.parquet';rel=f.relative_to(out).as_posix()
            if rel in state['parts']:
                if not f.exists() or f.stat().st_size!=state['parts'][rel]['bytes']:raise RuntimeError(f'Changed part: {rel}')
                continue
            tmp=f.with_suffix('.parquet.tmp')
            if tmp.exists():tmp.unlink()
            t=time.perf_counter();c.execute(f'COPY ({sql.format(lo=lo,hi=hi)}) TO {sqlstr(tmp)} (FORMAT PARQUET,COMPRESSION ZSTD,ROW_GROUP_SIZE 122880)');os.replace(tmp,f)
            state['parts'][rel]={'rows':hi-lo,'bytes':f.stat().st_size,'seconds':time.perf_counter()-t};save_json(mf,state)
            print(name,part,f'{hi-lo:,} rows',f'{f.stat().st_size/1e6:.1f} MB',flush=True)
    oracle=out/'_oracle';oracle.mkdir(exist_ok=True)
    c.execute(f"COPY (SELECT {code('i','commercial')} AS \"from\",{code('i','production')} AS \"to\" FROM range(1,{a.products+1}) t(i)) TO {sqlstr(oracle/'expected_map.csv')} (HEADER,DELIMITER ',')")
    # Never overwrite a project already edited in the application on --resume.
    project=out/'stress.dwhproj.json'
    if not project.exists():save_json(project,make_project(out))
    state['total_bytes']=sum(x['bytes'] for x in state['parts'].values());state['generation_seconds']=sum(x['seconds'] for x in state['parts'].values());save_json(mf,state)
    print(f"READY: {project}\n{state['total_bytes']/1e9:.3f} GB; {state['generation_seconds']:.1f}s; map is EMPTY. Open it in DWH Query.")

if __name__=='__main__':main()
