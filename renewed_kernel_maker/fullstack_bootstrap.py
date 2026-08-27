from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE=Path(__file__).resolve().parent
if str(HERE) not in sys.path:sys.path.insert(0,str(HERE))

from core import canonical,receipt
import corpus_build,curriculum,local_runtime,study_index,voxel_heldout
from local_model_maker import RuntimeConfig,probe

SCHEMA='archie-fullstack-bootstrap/v1'
DEFAULT_HF_REPO='Qwen/Qwen3-4B-GGUF'
DEFAULT_HF_FILE='Qwen3-4B-Q4_K_M.gguf'

def disk_free_gib(path:Path)->float:return shutil.disk_usage(path).free/(1024**3)
def run(argv:list[str],cwd:Path|None=None,timeout:int=600)->dict[str,Any]:
    try:
        p=subprocess.run(argv,cwd=str(cwd) if cwd else None,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
        return {'ok':p.returncode==0,'returncode':p.returncode,'stdout':p.stdout[-12000:]}
    except Exception as exc:return {'ok':False,'reason':f'{type(exc).__name__}: {exc}'}

def ensure_llama_server(cache:Path,allow_network:bool)->dict[str,Any]:
    existing=local_runtime.discover_executables().get('llama-server')
    if existing:return {'status':'READY','path':existing,'built':False}
    candidates=list(cache.rglob('llama-server'))+list(cache.rglob('llama-server.exe')) if cache.exists() else []
    if candidates:return {'status':'READY','path':str(candidates[0]),'built':False}
    if not allow_network:return {'status':'BLOCKED','reason':'llama-server-missing-and-network-disabled'}
    git=shutil.which('git');cmake=shutil.which('cmake')
    if not git or not cmake:return {'status':'BLOCKED','reason':'git-or-cmake-missing'}
    src=cache/'llama.cpp';cache.mkdir(parents=True,exist_ok=True)
    if not (src/'.git').is_dir():
        r=run([git,'clone','--depth','1','https://github.com/ggml-org/llama.cpp.git',str(src)],timeout=600)
        if not r['ok']:return {'status':'BLOCKED','reason':'llama.cpp-clone-failed','detail':r}
    else:run([git,'-C',str(src),'pull','--ff-only'],timeout=180)
    build=src/'build';r=run([cmake,'-S',str(src),'-B',str(build),'-DGGML_CUDA=ON','-DLLAMA_CURL=ON'],timeout=300)
    if not r['ok']:
        r=run([cmake,'-S',str(src),'-B',str(build),'-DGGML_CUDA=OFF','-DLLAMA_CURL=ON'],timeout=300)
    if not r['ok']:return {'status':'BLOCKED','reason':'llama.cpp-configure-failed','detail':r}
    r=run([cmake,'--build',str(build),'--config','Release','-j','2','--target','llama-server'],timeout=1800)
    if not r['ok']:return {'status':'BLOCKED','reason':'llama.cpp-build-failed','detail':r}
    hits=list(build.rglob('llama-server'))+list(build.rglob('llama-server.exe'))
    return {'status':'READY','path':str(hits[0]),'built':True} if hits else {'status':'BLOCKED','reason':'built-but-server-not-found'}

def ensure_model(cache:Path,allow_network:bool,repo:str=DEFAULT_HF_REPO,filename:str=DEFAULT_HF_FILE)->dict[str,Any]:
    roots=local_runtime.discover_model_roots([cache/'models']);found=local_runtime.discover([cache/'models'])['payload']['ggufs'];choice=local_runtime.choose_gguf(found,max_gib=5.6)
    # Prefer a known Qwen/Coder local file, but any existing admitted GGUF can be tried.
    if choice:return {'status':'READY','path':choice['path'],'source':'existing','gib':choice['gib']}
    if not allow_network:return {'status':'BLOCKED','reason':'no-admitted-gguf-and-network-disabled'}
    if disk_free_gib(cache)<8:return {'status':'BLOCKED','reason':'free-disk-below-8-gib','free_gib':disk_free_gib(cache)}
    dst=cache/'models'/filename;dst.parent.mkdir(parents=True,exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download
        p=hf_hub_download(repo_id=repo,filename=filename,local_dir=str(dst.parent))
        return {'status':'READY','path':str(Path(p)),'source':repo,'gib':Path(p).stat().st_size/(1024**3)}
    except Exception as first:
        import urllib.request
        url=f'https://huggingface.co/{repo}/resolve/main/{filename}?download=true';tmp=dst.with_suffix(dst.suffix+'.part')
        try:
            with urllib.request.urlopen(url,timeout=60) as r,tmp.open('wb') as f:
                while True:
                    chunk=r.read(8*1024*1024)
                    if not chunk:break
                    f.write(chunk)
                    if disk_free_gib(cache)<4:raise RuntimeError('disk reserve below 4 GiB during model download')
            tmp.replace(dst);return {'status':'READY','path':str(dst),'source':repo,'gib':dst.stat().st_size/(1024**3)}
        except Exception as second:
            tmp.unlink(missing_ok=True);return {'status':'BLOCKED','reason':f'model-download-failed:{type(first).__name__}/{type(second).__name__}','detail':str(second)}

def build_study(cache:Path,out:Path,allow_network:bool,max_sources:int=12)->dict[str,Any]:
    # Start with a broad but bounded batch. Later iterations can raise max_sources.
    plan=json.loads((HERE/'corpus_sources.json').read_text(encoding='utf-8'));plan['sources']=plan['sources'][:max(1,max_sources)];plan_path=out/'active-corpus-plan.json';out.mkdir(parents=True,exist_ok=True);plan_path.write_text(json.dumps(plan,indent=2),encoding='utf-8')
    corpus=corpus_build.build(plan_path,cache/'repos',out/'corpus',allow_network=allow_network)
    shards=sorted((out/'corpus'/'shards').glob('train-*.jsonl'))+sorted((out/'corpus'/'shards').glob('validation-*.jsonl'))
    db=out/'study.db';idx=study_index.ingest_jsonl(db,shards) if shards else {'inserted':0,'total':0,'skipped':0}
    cur=curriculum.generate(100000,1_000_000);cur_receipt=curriculum.write_shards(cur,out/'curriculum')
    return {'corpus':corpus,'study':idx,'study_db':str(db),'curriculum':cur_receipt['payload']}

def launch_maker_server(config:RuntimeConfig,workspace:Path,log:Path,port:int=8844)->dict[str,Any]:
    if local_runtime.port_open('127.0.0.1',port):return {'status':'REUSED','url':f'http://127.0.0.1:{port}'}
    log.parent.mkdir(parents=True,exist_ok=True);fh=log.open('ab',buffering=0);argv=[sys.executable,str(HERE/'maker_server.py'),'--host','127.0.0.1','--port',str(port),'--workspace',str(workspace),'--endpoint',config.endpoint,'--model',config.model]
    if config.study_db:argv+=['--study-db',config.study_db]
    kwargs={'start_new_session':True} if os.name!='nt' else {'creationflags':getattr(subprocess,'CREATE_NEW_PROCESS_GROUP',0)};p=subprocess.Popen(argv,stdout=fh,stderr=subprocess.STDOUT,**kwargs);deadline=time.time()+20
    while time.time()<deadline:
        if p.poll() is not None:return {'status':'FAILED','returncode':p.returncode}
        if local_runtime.port_open('127.0.0.1',port):return {'status':'READY','pid':p.pid,'url':f'http://127.0.0.1:{port}','argv':argv}
        time.sleep(.5)
    return {'status':'TIMEOUT','pid':p.pid,'argv':argv}

def execute(root:Path,allow_network:bool,max_sources:int=12,cases:int=3)->dict[str,Any]:
    root=root.resolve();root.mkdir(parents=True,exist_ok=True);cache=root/'cache';state=root/'state';state.mkdir(exist_ok=True);result={'schema':SCHEMA,'started_at':time.time(),'free_start_gib':disk_free_gib(root)}
    court=run([sys.executable,str(HERE/'maker_cli.py'),'court'],timeout=180);result['court']={'ok':court['ok'],'tail':court.get('stdout','')[-3000:]}
    if not court['ok']:result.update(status='BLOCKED',reason='promotion-court-failed');return receipt('fullstack.bootstrap',result)
    runtime=ensure_llama_server(cache,allow_network);result['runtime']=runtime
    if runtime['status']!='READY':result.update(status='BLOCKED',reason='runtime-unavailable');return receipt('fullstack.bootstrap',result)
    model=ensure_model(cache,allow_network);result['model']=model
    if model['status']!='READY':result.update(status='BLOCKED',reason='model-unavailable');return receipt('fullstack.bootstrap',result)
    study=build_study(cache,state,allow_network,max_sources=max_sources);result['study']={'documents':study['study'].get('total',0),'study_db':study['study_db'],'corpus_bytes':study['corpus'].get('shards',{}).get('bytes',0),'curriculum_records':study['curriculum'].get('records',0)}
    spec=local_runtime.RuntimeLaunch('llama.cpp',runtime['path'],model['path'],ctx=8192,gpu_layers=999,threads=0);lr=local_runtime.launch(spec,state/'llama-server.log',ready_timeout_s=180);result['model_server']=lr['payload']
    if lr['payload']['status'] not in {'READY','REUSED'}:result.update(status='BLOCKED',reason='model-server-failed');return receipt('fullstack.bootstrap',result)
    endpoint=lr['payload']['endpoint'];cfg=RuntimeConfig(endpoint=endpoint,model=Path(model['path']).stem,study_db=study['study_db'],timeout_s=180,max_tokens=8192);result['probe']=probe(cfg)['payload'];result['maker_server']=launch_maker_server(cfg,state/'projects',state/'maker-server.log');suite=voxel_heldout.evaluate_suite(cfg,state/'heldout',count=cases);result['voxel_suite']=suite['payload'];result['free_end_gib']=disk_free_gib(root);result['status']='SUCCESS' if suite['payload'].get('passes') else 'HELDOUT_FAILED';result['passes']=bool(suite['payload'].get('passes'));result['finished_at']=time.time();result['sha256']=hashlib.sha256(canonical(result)).hexdigest();(state/'FULLSTACK_RESULT.json').write_text(json.dumps(receipt('fullstack.bootstrap',result),indent=2),encoding='utf-8');return receipt('fullstack.bootstrap',result)
def main()->int:
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True);ap.add_argument('--allow-network',action='store_true');ap.add_argument('--max-sources',type=int,default=12);ap.add_argument('--cases',type=int,default=3);ns=ap.parse_args();r=execute(ns.root,ns.allow_network,ns.max_sources,ns.cases);print(json.dumps(r,indent=2));return 0 if r['payload'].get('passes') else 2
if __name__=='__main__':raise SystemExit(main())
