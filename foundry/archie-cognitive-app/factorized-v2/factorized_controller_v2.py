#!/usr/bin/env python3
from __future__ import annotations
import numpy as np
from factorized_controller import FactorizedController,ROUTES,REFS,SINGLE,split_clauses,text_features,attachment_text,align,softmax

class ConservativeFactorizedController(FactorizedController):
 schema='archie-factorized-controller/v2'
 def semantic_probs(self,rows,mode='conservative'):
  if mode in ('new','v9','fused'): return super().semantic_probs(rows,mode)
  texts=[r['request'] for r in rows]
  sem=self.b['semantic'].decision_function(text_features(texts,16384,4096));sem=align(sem,self.b['semantic'].classes_,ROUTES);new=softmax(sem/self.b['sem_temperature'])
  gru=softmax(self._byte_logits(texts)/self.b['gru_temperature'])
  v9log=self.v9['route'].decision_function(self._v9X(rows));v9log=align(v9log,self.v9['route'].classes_,ROUTES);v9=softmax(v9log)
  out=v9.copy()
  for i in range(len(rows)):
   ni,gi,vi=int(new[i].argmax()),int(gru[i].argmax()),int(v9[i].argmax())
   # Frozen v9 remains the default. Diverse students may repair only a low-margin v9 decision when they agree strongly.
   if ni==gi and ni!=vi and v9[i,vi]<.55 and new[i,ni]>.78 and gru[i,gi]>.78:
    logp=.2*np.log(np.clip(v9[i],1e-9,1))+.4*np.log(np.clip(new[i],1e-9,1))+.4*np.log(np.clip(gru[i],1e-9,1));out[i]=softmax(logp[None,:])[0]
  return out
 def reference_probs_conservative(self,rows):
  texts=[r['request'] for r in rows]
  v9=self.v9['reference'].predict_proba(text_features(texts,32768,8192));v9=align(v9,self.v9['reference'].classes_,REFS,fill=0.0)
  new=self.b['reference'].predict_proba(text_features(texts,12288,3072));new=align(new,self.b['reference'].classes_,REFS,fill=0.0)
  out=v9.copy()
  for i in range(len(rows)):
   vi,ni=int(v9[i].argmax()),int(new[i].argmax())
   if vi==ni: out[i]=.75*v9[i]+.25*new[i]
   elif v9[i,vi]<.58 and new[i,ni]>.92: out[i]=.65*v9[i]+.35*new[i]
  out/=out.sum(1,keepdims=True);return out
 def authority_probability_conservative(self,row):
  # Payloads are erased before authority inference. Authorization can only enter via trusted metadata.
  if bool(row.get('trusted_authorization') or row.get('owner_authorized')): return 0.0
  request_only={**row,'attachments':[],'memory':'','thread':''};text=[row['request']];v9x=self._v9X([request_only]);small=text_features(text,8192,2048);cat=text_features(text,16384,4096)
  def p1(m,X):return float(m.predict_proba(X)[0,list(m.classes_).index(1)])
  pchar=p1(self.v9['authority_char'],v9x);catp=self.v9['authority_category'].predict_proba(cat)[0];safe=float(catp[list(self.v9['authority_category'].classes_).index('safe')]);pnew=float(self.authority_probs([request_only])[0]);psafe=p1(self.b['safe_purpose'],small)
  if safe>.65 and psafe>.78 and pchar<.95:return min(.49,pnew)
  if pchar>=.90:return max(pchar,pnew)
  if pchar>=.72 and safe<.50:return max(pchar,pnew)
  if pnew>=.94 and pchar>=.45:return pnew
  return min(pchar,pnew,.49)
 def clause_probs_v9(self,clauses):
  rows=[{'request':c,'attachments':[],'memory':'','thread':''} for c in clauses];p=self.v9['clause'].predict_proba(self._v9X(rows));return align(p,self.v9['clause'].classes_,ROUTES,fill=0.0)
 def infer(self,row,semantic_mode='conservative'):
  base=dict(row);text=str(base.get('request') or base.get('text') or '');base['request']=text
  authority_p=self.authority_probability_conservative(base)
  if authority_p>=.5:
   probs=np.full(len(ROUTES),(1-authority_p)/(len(ROUTES)-1));probs[ROUTES.index('clarify')]=authority_p
   return {'route':'clarify','authority':'deny','context':'ready','outcomes':[],'confidence':float(probs.max()),'probabilities':dict(zip(ROUTES,map(float,probs))),'decision_source':'factor-authority-v2','reference':'none'}
  rp=self.reference_probs_conservative([base])[0];ref=REFS[int(rp.argmax())];newrp=super().reference_probs([base])[0];newref=REFS[int(newrp.argmax())]
  if ref=='generic_missing' and newref=='ambiguous' and float(newrp.max())>.82:ref='ambiguous'
  present={'attachment':bool(base.get('attachments')),'memory':bool(base.get('memory')),'thread':bool(base.get('thread'))};context='ready'
  if ref=='ambiguous':context='ambiguous'
  elif ref=='generic_missing':context='missing'
  elif ref in present:
   context='ready' if present[ref] and self._usable(base)>=.18 else 'missing'
  if context!='ready':
   gate=max(float(rp.max()),.55);probs=np.full(len(ROUTES),(1-gate)/(len(ROUTES)-1));probs[ROUTES.index('clarify')]=gate
   return {'route':'clarify','authority':'allow','context':context,'outcomes':[],'confidence':float(probs.max()),'probabilities':dict(zip(ROUTES,map(float,probs))),'decision_source':'typed-reference-v2','reference':ref}
  clauses=split_clauses(text);whole=self.semantic_probs([base],semantic_mode)[0]
  if len(clauses)>=2:
   cp=self.clause_probs_v9(clauses);outcomes=[];conf=[]
   for p in cp:
    label=ROUTES[int(p.argmax())]
    if label in SINGLE and (not outcomes or outcomes[-1]!=label):outcomes.append(label);conf.append(float(p.max()))
   if len(outcomes)>=2:
    c=min(conf[:2]);probs=np.full(len(ROUTES),(1-c)/(len(ROUTES)-1));probs[ROUTES.index('compound')]=c
    return {'route':'compound','authority':'allow','context':'ready','outcomes':outcomes[:2],'confidence':c,'probabilities':dict(zip(ROUTES,map(float,probs))),'decision_source':'clause-composition-v2','reference':ref}
  route=ROUTES[int(whole.argmax())]
  if route=='compound':
   # Fail closed on unsupported composition rather than inventing outcomes.
   alt=whole.copy();alt[ROUTES.index('compound')]=-1;route=ROUTES[int(alt.argmax())]
  outcomes=[] if route=='clarify' else [route]
  return {'route':route,'authority':'allow','context':'ready','outcomes':outcomes,'confidence':float(whole.max()),'probabilities':dict(zip(ROUTES,map(float,whole))),'decision_source':'semantic-conservative-v2','reference':ref}
