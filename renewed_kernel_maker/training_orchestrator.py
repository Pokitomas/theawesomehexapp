from __future__ import annotations

import argparse
import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from core import canonical, receipt
import curriculum
from local_model_maker import RuntimeConfig, probe, run_maker
import trajectory_dataset
import train_sft

SCHEMA = "archie-maker-training-loop/v1"


def grade_generic(root: Path, domain: str, required: list[str] | tuple[str, ...]) -> dict[str, Any]:
    files=[p for p in sorted(root.rglob('*')) if p.is_file()]
    text='\n'.join(p.read_text(encoding='utf-8',errors='replace')[:300000] for p in files if p.suffix.lower() in {'.py','.js','.ts','.tsx','.jsx','.rs','.c','.cc','.cpp','.h','.hpp','.html','.css','.json','.md','.sh'})
    low=text.lower()
    feature_hits={f:any(token in low for token in f.lower().replace('/',' ').replace('-',' ').split() if len(token)>=4) for f in required}
    entry=any(p.name in {'index.html','main.py','app.py','main.rs','package.json','Cargo.toml'} for p in files)
    substantive=sum(p.stat().st_size for p in files)>=600
    no_remote='https://' not in low and 'http://' not in low
    score=(sum(feature_hits.values())+int(entry)+int(substantive)+int(no_remote))/(len(feature_hits)+3)
    return {'domain':domain,'entry':entry,'substantive':substantive,'offline_signal':no_remote,'features':feature_hits,'score':score,'passes':entry and substantive and score>=0.72}


def run_train_cases(config: RuntimeConfig, out: Path, *, count: int=24, base_seed: int=2_000_000) -> dict[str, Any]:
    if probe(config)['payload']['status']!='READY': return receipt('training_loop.collect',{'status':'BLOCKED','reason':'local-model-not-ready','passes':False})
    tasks=[t for t in curriculum.generate(max(count*2,64),base_seed)['tasks'] if t['split']=='train'][:count]
    cases=[]; out.mkdir(parents=True,exist_ok=True)
    for task in tasks:
        root=out/task['id']; run=run_maker(config,task['brief'],root,max_steps=64,record_approved_brief=True); grade=grade_generic(root,task['domain'],task['required']); cases.append({'task':task,'maker':run['payload'],'grade':grade,'passes':run['payload']['status']=='FINISHED' and grade['passes']})
    body={'status':'COMPLETE','cases':cases,'passed':sum(c['passes'] for c in cases),'total':len(cases)};body['success_rate']=body['passed']/max(1,body['total']);body['sha256']=hashlib.sha256(canonical(body)).hexdigest();return receipt('training_loop.collect',body)


def dataset_from_collection(collection: dict[str,Any], out_jsonl: Path) -> dict[str,Any]:
    values=[]
    for c in collection.get('payload',{}).get('cases',[]):
        run=c.get('maker')
        if not isinstance(run,dict):continue
        # Keep successful demonstrations and failed trajectories that actually contain tool evidence.
        if run.get('approved_brief') and run.get('events'): values.append(run)
    ds=trajectory_dataset.compile_sft(values); wr=trajectory_dataset.write_jsonl(ds,out_jsonl);return receipt('training_loop.dataset',{'records':ds['count'],'dataset_sha256':ds['sha256'],'file':wr['payload']})


def execute_iteration(config: RuntimeConfig, root: Path, *, train_cases:int=24, base_model:str='Qwen/Qwen3-4B', execute_sft:bool=False) -> dict[str,Any]:
    stamp=str(int(time.time())); it=root/f'iteration-{stamp}'; collect=run_train_cases(config,it/'projects',count=train_cases); result={'schema':SCHEMA,'collection':collect['payload']}
    if collect['payload'].get('status')!='COMPLETE':return receipt('training_loop.iteration',{**result,'status':'BLOCKED','passes':False})
    ds=dataset_from_collection(collect,it/'train.jsonl');result['dataset']=ds['payload']
    recipe=train_sft.Recipe(base_model,str(it/'train.jsonl'),str(it/'sft'),epochs=1.0)
    tr=train_sft.train(recipe) if execute_sft else train_sft.recipe_receipt(recipe);result['training']=tr['payload'];result['status']='TRAINED' if tr['payload'].get('status')=='COMPLETE' else ('DATA_READY' if tr['payload'].get('admissible') else 'BLOCKED');result['passes']=bool(ds['payload']['records']>0 and (tr['payload'].get('admissible') or tr['payload'].get('status')=='COMPLETE'));result['sha256']=hashlib.sha256(canonical(result)).hexdigest();(it/'iteration-receipt.json').write_text(json.dumps(receipt('training_loop.iteration',result),indent=2),encoding='utf-8');return receipt('training_loop.iteration',result)


def court()->dict[str,Any]:
    tasks=curriculum.generate(200,99001)['tasks'];train=[x for x in tasks if x['split']=='train'];held=[x for x in tasks if x['split']=='heldout'];overlap={x['id'] for x in train}&{x['id'] for x in held};return receipt('training_orchestrator.court',{'passes':not overlap and bool(train) and bool(held),'train':len(train),'heldout':len(held),'overlap':sorted(overlap),'rule':'collection uses train split only; heldout evaluation remains external'})


def main()->int:
    ap=argparse.ArgumentParser();ap.add_argument('--endpoint',default='http://127.0.0.1:8080/v1/chat/completions');ap.add_argument('--model',default='local-model');ap.add_argument('--study-db',default='');ap.add_argument('--out',type=Path,required=True);ap.add_argument('--train-cases',type=int,default=24);ap.add_argument('--base-model',default='Qwen/Qwen3-4B');ap.add_argument('--execute-sft',action='store_true');ns=ap.parse_args();r=execute_iteration(RuntimeConfig(endpoint=ns.endpoint,model=ns.model,study_db=ns.study_db),ns.out,train_cases=ns.train_cases,base_model=ns.base_model,execute_sft=ns.execute_sft);print(json.dumps(r,indent=2));return 0 if r['payload'].get('passes') else 2
if __name__=='__main__':raise SystemExit(main())
