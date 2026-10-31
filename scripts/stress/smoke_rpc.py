#!/usr/bin/env python3
"""Optional automated smoke of the SAME Rust matcher/export/build RPC used by Electron.
This tests backend plumbing; the README's interactive run is still the UI test.
Never reads the oracle to fill a KeyMap. Requires generated inputs + built dwh-host + dbt.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
from base_generator import save_json


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,required=True);p.add_argument('--host',type=Path,required=True)
    p.add_argument('--dbt-dir',type=Path,required=True,help='Directory containing dbt executable')
    p.add_argument('--timeout',type=float,default=600)
    p.add_argument('--export-dir',type=Path,help='Optional export parent; default <data>/_rpc_smoke_export')
    p.add_argument('--builds',type=int,default=1,help='Build and verify repeatedly, without resetting the database')
    a=p.parse_args();data=a.data.resolve()
    if a.builds<1:p.error('--builds must be positive')
    export_dir=(a.export_dir or data/'_rpc_smoke_export').resolve()
    project=json.loads((data/'stress.dwhproj.json').read_text())
    env={**os.environ,'DWH_HOST_TCP':'1','DBT_SEND_ANONYMOUS_USAGE_STATS':'false','PATH':str(a.dbt_dir.resolve())+os.pathsep+os.environ.get('PATH','')}
    timings={};passed=False;log=open(data/'rpc-host.log','w')
    host=subprocess.Popen([str(a.host.resolve())],stdout=subprocess.PIPE,stderr=log,text=True,env=env)
    try:
        while True:
            line=host.stdout.readline()
            if not line:raise RuntimeError('Host failed to start; see rpc-host.log')
            if line.startswith('DWH_HOST_READY tcp '):port=int(line.split()[-1]);break
        s=socket.create_connection(('127.0.0.1',port),timeout=a.timeout);s.settimeout(a.timeout)
        seq=0
        def exact(n):
            out=bytearray()
            while len(out)<n:
                b=s.recv(n-len(out))
                if not b:raise RuntimeError('Host disconnected')
                out+=b
            return out
        def rpc(cmd,args):
            nonlocal seq
            seq+=1;t=time.perf_counter();body=json.dumps({'id':seq,'cmd':cmd,'args':args}).encode()
            s.sendall(struct.pack('<I',len(body))+body)
            length=struct.unpack('<I',exact(4))[0]
            response=json.loads(exact(length));timings[cmd]=time.perf_counter()-t
            if not response['ok']:raise RuntimeError(response['error'])
            return response['result']
        ws=project['workspace']
        match=rpc('key_map_fuzzy_suggest',{'workspace':ws,'connections':[],
          'left':{'query_id':'commercial_catalog','key_column':'commercial_code','label_column':'name'},
          'right':{'query_id':'production_catalog','key_column':'product_code','label_column':'name'}})
        expected=json.loads((data/'manifest.json').read_text())['config']['products']
        if match['unmatched'] or match['ambiguous'] or len(match['suggestions'])!=expected:raise RuntimeError(f'Incomplete fuzzy: {len(match["suggestions"])}/{expected}; ambiguous {match["ambiguous"]}')
        entries=[{'from':r['from_key'],'to':r['to_key']} for r in match['suggestions']]
        ws['key_maps'][0]['entries']=entries
        for q in ws['queries']:
            for step in q['steps']:
                if step['type']=='ApplyKeyMap':step['payload']['entries']=entries
        preview=rpc('preview_workspace',{'workspace':{**ws,'focus_query_id':'sales_mapped'},'connections':[]})
        code_index=next(i for i,col in enumerate(preview['columns']) if col['name']=='product_code')
        if not preview['rows'] or any(not str(row[code_index]).startswith('TECH-') for row in preview['rows']):
            raise RuntimeError('Mapped preview did not return production codes')
        saved=data/'stress.rpc.dwhproj.json';save_json(saved,project)
        exported=rpc('export_dbt',{'pipelineName':project['name'],'workspace':ws,
          'outputDir':str(export_dir),'dbtTarget':'v1','executionEngine':'duckdb',
          'destinationKind':'duckdb','connections':[],'outputs':project['outputs'],'skipParse':True})
        root=exported.get('path') or exported.get('output_path')
        if not root:root=str(export_dir/project['name'])
        for iteration in range(a.builds):
            build=rpc('build_export',{'path':root})
            timings[f'build_{iteration+1}']=timings.pop('build_export')
            (data/f'rpc-dbt-build-{iteration+1}.log').write_text(build.get('log',''))
            save_json(data/'rpc-timings.json',timings)
            if not build['ok']:raise RuntimeError(f'dbt build {iteration+1} failed; see rpc-dbt-build-{iteration+1}.log')
            subprocess.run([os.sys.executable,str(Path(__file__).with_name('verify.py')),'--data',str(data),
              '--project',str(saved),'--export',root],check=True)
        s.close()
        passed=True
        print(json.dumps(timings,indent=2))
    finally:
        save_json(data/'rpc-result.json',{'ok':passed,'timings':timings,'export_dir':str(export_dir),'requested_builds':a.builds})
        host.terminate()
        try:host.wait(timeout=10)
        except subprocess.TimeoutExpired:host.kill();host.wait()
        log.close()

if __name__=='__main__':main()
