#!/usr/bin/env python3
"""Train a causal-register-lattice candidate from canonical Archie rows."""
from __future__ import annotations
import argparse,datetime,hashlib,json,re
from pathlib import Path
from typing import Any
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.pipeline import FeatureUnion
from sklearn.svm import LinearSVC
from causal_register_lattice import CausalRegisterLattice,SINGLE,contrast_focus,ordered_segments

def sha(path:Path)->str:return hashlib.sha256(path.read_bytes()).hexdigest()
def features(word:int=25000,char:int=30000):
 return FeatureUnion([('word',TfidfVectorizer(ngram_range=(1,3),max_features=word,sublinear_tf=True,strip_accents='unicode')),('char',TfidfVectorizer(analyzer='char_wb',ngram_range=(3,5),max_features=char,sublinear_tf=True,strip_accents='unicode'))])
def load_records(path:Path)->list[dict[str,Any]]:
 text=path.read_text();value=json.loads(text) if path.suffix=='.json' else [json.loads(line) for line in text.splitlines() if line.strip()]
 rows=[]
 for item in value:
  if isinstance(item.get('expected'),dict):
   e=item['expected'];rows.append({'text':item.get('request') or item.get('text',''),'route':e['route'],'outcomes':e.get('outcomes',[]),'authority':int(e.get('authority')=='deny')})
  else:
   route=item.get('route') or item.get('expected');rows.append({'text':item.get('text') or item.get('request',''),'route':route,'outcomes':item.get('outcomes',[]),'authority':int(item.get('authority') in (1,True,'deny'))})
 return [r for r in rows if r['text'] and r['route']]
def augment_routes(rows):
 out=[]
 for row in rows:
  out.append((row['text'],row['route']));focus=contrast_focus(row['text'])
  if focus and row['route'] in SINGLE:out.extend([(focus,row['route']),('Please '+focus,row['route'])])
 return out
def augment_authority(rows):
 out=[];replacements=[('private','confidential'),('approval','authorization'),('approved','authorized'),('erase','purge'),('hidden','concealed'),('browser','local profile'),('memory','resources'),('unresponsive','not responding'),('promoted','accepted'),('camera','imaging device'),('deployment','release action')]
 for row in rows:
  y=row['authority'];out.append((row['text'],y))
  if y:
   for a,b in replacements:
    if a in row['text'].lower():out.append((re.sub(a,b,row['text'],flags=re.I),y))
 return out
def main()->int:
 p=argparse.ArgumentParser();p.add_argument('--spine',required=True);p.add_argument('--training',action='append',required=True);p.add_argument('--output',required=True);p.add_argument('--receipt',required=True);p.add_argument('--seed',type=int,default=3407);a=p.parse_args()
 sources=[Path(x) for x in a.training];rows=[r for path in sources for r in load_records(path)]
 rr=augment_routes(rows);rv=features();route=LinearSVC(C=2.7,class_weight='balanced',max_iter=7500,random_state=a.seed).fit(rv.fit_transform([x for x,_ in rr]),[y for _,y in rr])
 segments=[]
 for row in rows:
  if row['route'] in SINGLE:segments.append((row['text'],row['route']))
  elif row['route']=='compound' and row['outcomes']:
   parts=ordered_segments(row['text'])
   if len(parts)>=len(row['outcomes']):segments.extend(zip(parts[:len(row['outcomes'])],row['outcomes']))
 sv=features(22000,26000);segment=LinearSVC(C=3.1,class_weight='balanced',max_iter=7500,random_state=a.seed+4).fit(sv.fit_transform([x for x,_ in segments]),[y for _,y in segments])
 ar=augment_authority(rows);av=features(12000,16000);authority=SGDClassifier(loss='log_loss',alpha=2e-6,max_iter=2000,tol=1e-5,class_weight='balanced',average=True,random_state=a.seed+6).fit(av.fit_transform([x for x,_ in ar]),[y for _,y in ar])
 model=CausalRegisterLattice(joblib.load(a.spine),rv,route,sv,segment,av,authority,.5,{'promotion':'not-admitted','source_files':[str(x) for x in sources]})
 output=Path(a.output);joblib.dump(model,output,compress=3)
 receipt={'schema':'archie-causal-register-lattice-training/v1','trained_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':len(rows),'route_rows':len(rr),'segment_rows':len(segments),'authority_rows':len(ar),'sources':{str(x):{'bytes':x.stat().st_size,'sha256':sha(x)} for x in sources},'spine_sha256':sha(Path(a.spine)),'artifact_sha256':sha(output),'artifact_bytes':output.stat().st_size,'promotion':'not-admitted'}
 Path(a.receipt).write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n');print(json.dumps(receipt,indent=2));return 0
if __name__=='__main__':raise SystemExit(main())
