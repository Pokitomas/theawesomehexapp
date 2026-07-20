#!/usr/bin/env python3
from __future__ import annotations
import json, math, re, time
from functools import lru_cache
from pathlib import Path
from typing import Any
import joblib
import numpy as np
import torch
from torch import nn
from scipy import sparse
from sklearn.feature_extraction.text import HashingVectorizer

ROUTES=['checklist','clarify','compound','decision','errands','event','message','next_action','objective','plan','study','summary']
REFS=['ambiguous','attachment','generic_missing','memory','none','thread']
SINGLE=[r for r in ROUTES if r not in ('clarify','compound')]

class ByteGRU(nn.Module):
 def __init__(self,emb=24,hid=48):
  super().__init__();self.emb=nn.Embedding(257,emb,padding_idx=0);self.gru=nn.GRU(emb,hid,batch_first=True,bidirectional=True);self.head=nn.Linear(hid*2,len(ROUTES))
 def forward(self,x,l):
  z=self.emb(x);z,_=self.gru(z);m=torch.arange(z.shape[1])[None,:].to(z.device)<l[:,None].to(z.device);return self.head((z*m[:,:,None]).sum(1)/l[:,None].clamp_min(1))

@lru_cache(maxsize=64)
def hvec(dim,analyzer,ng):return HashingVectorizer(n_features=dim,analyzer=analyzer,ngram_range=ng,alternate_sign=False,norm='l2',lowercase=True,strip_accents='unicode',token_pattern=r'(?u)\b\w+\b')
def text_features(texts,char_dim=32768,word_dim=8192):return sparse.hstack([hvec(char_dim,'char_wb',(3,5)).transform(texts),hvec(word_dim,'word',(1,2)).transform(texts)],format='csr')
def attachment_text(v):
 return ' '.join(str(x.get('name') or x.get('filename') or x.get('type') or x) if isinstance(x,dict) else str(x) for x in (v or []))
def softmax(z):
 z=np.asarray(z,float);z=z-z.max(axis=-1,keepdims=True);e=np.exp(z);return e/e.sum(axis=-1,keepdims=True)
def align(values,classes,target,fill=-20.0):
 z=np.full((len(values),len(target)),fill,float)
 for i,c in enumerate(classes):
  if str(c) in target:z[:,target.index(str(c))]=values[:,i]
 return z

def correction_focus(text:str)->str:
 # Structural contrast extraction only; it does not encode route vocabulary.
 parts=[p.strip(' ,.;:-') for p in re.split(r'(?i)\b(?:instead|rather|replace (?:it|that) with|but)\b|[.;]',text) if p.strip(' ,.;:-')]
 if len(parts)>=2 and re.search(r'(?i)\b(?:do not|don\'t|cancel|skip|omit|not)\b',parts[0]): return parts[-1]
 return text.strip()
def split_clauses(text:str)->list[str]:
 if correction_focus(text)!=text.strip(): return [correction_focus(text)]
 connector=r'\s*(?:;|\band then\b|\bthen\b|\bafterward\b|\bsubsequently\b|\bthereafter\b|\bupon closure of the former\b|\bonce (?:that|this) is complete\b|\bfollowing completion\b)\s*'
 parts=[p.strip(' ,.;:-') for p in re.split(connector,text,flags=re.I) if len(p.strip(' ,.;:-').split())>=2]
 return parts[:4] if len(parts)>=2 else [text.strip()]

class FactorizedController:
 def __init__(self,bundle_path:str,gru_path:str,v9_path:str,quantized_gru:bool=False):
  torch.set_num_threads(4)
  self.b=joblib.load(bundle_path);self.v9=joblib.load(v9_path)
  ck=torch.load(gru_path,map_location='cpu',weights_only=True);self.gru=ByteGRU(**ck['config']);self.gru.load_state_dict(ck['state_dict']);self.gru.eval();self.quantized=False
  if quantized_gru:
   try:
    self.gru=torch.ao.quantization.quantize_dynamic(self.gru,{nn.GRU,nn.Linear},dtype=torch.qint8);self.quantized=True
   except Exception:self.quantized=False
  self.cfg=self.v9['feature_config']
 def _v9X(self,rows):
  req=[r['request'] for r in rows];mem=[r.get('memory','') or '' for r in rows];thr=[r.get('thread','') or '' for r in rows];att=[attachment_text(r.get('attachments')) for r in rows];c=self.cfg
  return sparse.hstack([hvec(c['req_char_dim'],'char_wb',(3,5)).transform(req),hvec(c['req_word_dim'],'word',(1,2)).transform(req),hvec(c['memory_dim'],'char_wb',(3,5)).transform(mem)*c['memory_weight'],hvec(c['attachment_dim'],'char_wb',(3,5)).transform(att)*c['attachment_weight'],hvec(c['thread_dim'],'char_wb',(3,5)).transform(thr)*c['thread_weight']],format='csr')
 def _byte_logits(self,texts):
  seq=[torch.tensor([b+1 for b in t.casefold().encode()[:220]] or [1],dtype=torch.long) for t in texts];n=max(map(len,seq));X=torch.zeros(len(seq),n,dtype=torch.long);L=[]
  for i,x in enumerate(seq):X[i,:len(x)]=x;L.append(len(x))
  with torch.no_grad():return self.gru(X,torch.tensor(L)).detach().float().numpy()
 def semantic_probs(self,rows,mode='fused'):
  texts=[r['request'] for r in rows]
  sem=self.b['semantic'].decision_function(text_features(texts,16384,4096));sem=align(sem,self.b['semantic'].classes_,ROUTES)
  if mode=='new': return softmax(sem/self.b['sem_temperature'])
  gru=self._byte_logits(texts)/self.b['gru_temperature'];v9=self.v9['route'].decision_function(self._v9X(rows));v9=align(v9,self.v9['route'].classes_,ROUTES)
  if mode=='v9':return softmax(v9)
  X=np.hstack([sem/self.b['sem_temperature'],gru,v9]);return self.b['stack'].predict_proba(X)
 def reference_probs(self,rows):
  texts=[r['request'] for r in rows]
  a=np.log(np.clip(self.b['reference'].predict_proba(text_features(texts,12288,3072)),1e-9,1));a=align(a,self.b['reference'].classes_,REFS)
  b=np.log(np.clip(self.v9['reference'].predict_proba(text_features(texts,32768,8192)),1e-9,1));b=align(b,self.v9['reference'].classes_,REFS)
  return self.b['reference_stack'].predict_proba(np.hstack([a,b]))
 def authority_probs(self,rows):
  texts=[r['request'] for r in rows];small=text_features(texts,8192,2048);v9x=self._v9X(rows);cat=text_features(texts,16384,4096)
  def p1(m,X):return m.predict_proba(X)[:,list(m.classes_).index(1)]
  safe=self.v9['authority_category'].predict_proba(cat)[:,list(self.v9['authority_category'].classes_).index('safe')]
  X=np.column_stack([p1(self.b['actionability'],small),p1(self.b['target_risk'],small),p1(self.b['safe_purpose'],small),p1(self.v9['authority_char'],v9x),safe])
  return self.b['authority_stack'].predict_proba(X)[:,list(self.b['authority_stack'].classes_).index(1)]
 def _usable(self,row):
  payload=attachment_text(row.get('attachments'))+' '+str(row.get('memory') or '')+' '+str(row.get('thread') or '')
  X=text_features([row['request']+' <PAYLOAD> '+payload],8192,2048);m=self.b['usability'];return float(m.predict_proba(X)[0,list(m.classes_).index(1)])
 def infer(self,row:dict[str,Any],semantic_mode='fused'):
  base=dict(row); text=str(base.get('request') or base.get('text') or '');base['request']=text
  authority_p=float(self.authority_probs([base])[0])
  if authority_p>=.5:
   probs=np.full(len(ROUTES),(1-authority_p)/(len(ROUTES)-1));probs[ROUTES.index('clarify')]=authority_p
   return {'route':'clarify','authority':'deny','context':'ready','outcomes':[],'confidence':float(probs.max()),'probabilities':dict(zip(ROUTES,probs)),'decision_source':'factor-authority','reference':'none'}
  ref_probs=self.reference_probs([base])[0];ref=REFS[int(np.argmax(ref_probs))];ref_conf=float(ref_probs.max());context='ready'
  present={'attachment':bool(base.get('attachments')),'memory':bool(base.get('memory')),'thread':bool(base.get('thread'))}
  if ref=='ambiguous':context='ambiguous'
  elif ref=='generic_missing':context='missing'
  elif ref in present:
   context='ready' if present[ref] and self._usable(base)>=.5 else 'missing'
  if context!='ready':
   gate=max(ref_conf,.5);probs=np.full(len(ROUTES),(1-gate)/(len(ROUTES)-1));probs[ROUTES.index('clarify')]=gate
   return {'route':'clarify','authority':'allow','context':context,'outcomes':[],'confidence':float(probs.max()),'probabilities':dict(zip(ROUTES,probs)),'decision_source':'typed-reference','reference':ref}
  clauses=split_clauses(text);active=[];clause_probs=[]
  for c in clauses:
   cr={**base,'request':c,'attachments':[],'memory':'','thread':''};p=self.semantic_probs([cr],semantic_mode)[0];label=ROUTES[int(np.argmax(p))]
   if label not in ('clarify','compound'):active.append(label);clause_probs.append(p)
  if len(active)>=2:
   route='compound';outcomes=active[:2];confidence=float(min(max(p) for p in clause_probs[:2]));probs=np.full(len(ROUTES),(1-confidence)/(len(ROUTES)-1));probs[ROUTES.index('compound')]=confidence;source='clause-composition'
  else:
   p=self.semantic_probs([base],semantic_mode)[0];route=ROUTES[int(np.argmax(p))];outcomes=[] if route=='clarify' else ([route] if route!='compound' else active[:2]);confidence=float(p.max());probs=p;source=f'semantic-{semantic_mode}'
   if route=='compound' and len(outcomes)<2:
    # No compound without two independently decoded active clauses.
    best=[(p[i],ROUTES[i]) for i in range(len(ROUTES)) if ROUTES[i] not in ('compound','clarify')];best.sort(reverse=True);route=best[0][1];outcomes=[route];confidence=float(best[0][0]);source='compound-evidence-fallback'
  return {'route':route,'authority':'allow','context':'ready','outcomes':outcomes,'confidence':confidence,'probabilities':dict(zip(ROUTES,map(float,probs))),'decision_source':source,'reference':ref}
