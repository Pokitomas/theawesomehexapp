#!/usr/bin/env python3
from __future__ import annotations
import argparse,datetime,hashlib,json
from pathlib import Path
from collections import defaultdict
import joblib

def sha(path:Path)->str:return hashlib.sha256(path.read_bytes()).hexdigest()
def read_jsonl(path):return [json.loads(x) for x in Path(path).read_text().splitlines() if x.strip()]
def main()->int:
 p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--legacy',action='append',default=[]);p.add_argument('--capability',action='append',default=[]);p.add_argument('--out',required=True);a=p.parse_args();model=joblib.load(a.model);results={}
 for name in a.legacy:
  path=Path(name);rows=read_jsonl(path);correct=sum(model.infer(r.get('text') or r.get('request',''))['route']==(r.get('expected') or r.get('route')) for r in rows);results[path.name]={'kind':'legacy-route','rows':len(rows),'correct':correct,'accuracy':correct/max(1,len(rows)),'sha256':sha(path)}
 for name in a.capability:
  path=Path(name);rows=json.loads(path.read_text());cats=defaultdict(lambda:[0,0]);errors=[];correct=0
  for r in rows:
   actual=model.infer({'request':r['request'],'attachments':r.get('attachments',[]),'memory':r.get('memory',''),'thread':r.get('thread',''),'context_known':True});e=r['expected'];ok=all([actual['route']==e['route'],actual['authority']==e['authority'],actual['context']==e['context'],actual['outcomes']==e['outcomes']]);correct+=ok;cats[r.get('category','uncategorized')][0]+=ok;cats[r.get('category','uncategorized')][1]+=1
   if not ok:errors.append({'id':r.get('id'),'expected':e,'actual':actual})
  results[path.name]={'kind':'typed-exact','rows':len(rows),'correct':correct,'accuracy':correct/max(1,len(rows)),'sha256':sha(path),'categories':{k:{'correct':v[0],'rows':v[1]} for k,v in sorted(cats.items())},'errors':errors}
 receipt={'schema':'archie-causal-register-lattice-evaluation/v1','executed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'model_sha256':sha(Path(a.model)),'results':results,'promotion':'not-admitted'};Path(a.out).write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n');print(json.dumps(receipt,indent=2));return 0
if __name__=='__main__':raise SystemExit(main())
