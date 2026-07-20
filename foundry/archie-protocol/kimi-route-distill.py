#!/usr/bin/env python3
"""Failure-directed Kimi/OpenAI-compatible distillation for Archie routes."""
import argparse, hashlib, json, os, re, time, urllib.request
from collections import Counter
from pathlib import Path

ROUTES=['checklist','clarify','compound','decision','errands','event','message','next_action','objective','plan','study','summary']
AUTH=['allow','deny']; CONTEXT=['ready','missing','ambiguous']
FAILURES=['unseen-summary-decision-phrasing','safe-security-documentation','memory-operation-conflict','punctuation-and-before-compounds','vague-reference-abstention','negation-and-correction-clause-activity']
STYLES=['casual text message','spoken request with filler words','messy mobile dictation','polite request','urgent informal request','context-dependent follow-up']
TOKENS=re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")

def canon(x): return ' '.join(TOKENS.findall(str(x or '').lower().replace('’',"'")))
def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def user_text(row):
    for key in ('text','prompt','request'):
        if isinstance(row.get(key),str) and row[key].strip(): return row[key]
    for msg in row.get('messages') or []:
        if msg.get('role')!='user': continue
        value=msg.get('content')
        if isinstance(value,str): return value
        if isinstance(value,list): return ' '.join(p.get('text','') for p in value if isinstance(p,dict)).strip()
    return ''
def load(path):
    p=Path(path)
    if p.suffix=='.jsonl': return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
    value=json.loads(p.read_text()); return value if isinstance(value,list) else value.get('rows',[])
def frozen(paths): return {canon(user_text(r)) for p in paths if Path(p).exists() for r in load(p) if user_text(r)}
def jaccard(a,b):
    a,b=set(canon(a).split()),set(canon(b).split()); return len(a&b)/max(1,len(a|b))
def endpoint(base):
    base=base.rstrip('/')
    if base.endswith('/chat/completions'): return base
    return base+'/chat/completions' if base.endswith('/v1') else base+'/v1/chat/completions'

class Cache:
    def __init__(self,path):
        self.path=Path(path) if path else None; self.data={}
        if self.path and self.path.exists():
            for line in self.path.read_text().splitlines():
                if line.strip():
                    row=json.loads(line); self.data[row['key']]=row['value']
    def call(self,key,fn):
        if key in self.data: return self.data[key]
        value=fn(); self.data[key]=value
        if self.path:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            with self.path.open('a') as f: f.write(json.dumps({'key':key,'value':value},ensure_ascii=False)+'\n')
        return value

def request_body(args,messages,temp,max_completion_tokens):
    body={
        'model':args.model,
        'messages':messages,
        'response_format':{'type':'json_object'},
        'max_completion_tokens':max_completion_tokens,
    }
    model=args.model.lower()
    is_k3=('kimi-k3' in model or 'kimi_k3' in model or model in {'k3','kimi/k3'} or model.endswith('/k3'))
    if is_k3:
        # K3 always reasons. It rejects the K2.x `thinking` object and fixes
        # sampling parameters, so omit both `thinking` and `temperature`.
        body['reasoning_effort']=args.reasoning_effort or ('max' if args.thinking else 'low')
    else:
        body['temperature']=temp
        if 'kimi' in model:
            body['thinking']={'type':'enabled' if args.thinking else 'disabled'}
    return body

def teacher(args,cache,messages,temp,max_completion_tokens):
    body=request_body(args,messages,temp,max_completion_tokens)
    key=digest({'endpoint':endpoint(args.endpoint),**body})
    def request():
        req=urllib.request.Request(endpoint(args.endpoint),data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':f'Bearer {args.api_key}'})
        error=None
        for attempt in range(args.retries+1):
            try:
                with urllib.request.urlopen(req,timeout=args.timeout) as response: payload=json.load(response)
                return json.loads(payload['choices'][0]['message']['content'])
            except Exception as exc:
                error=exc
                if attempt<args.retries: time.sleep(min(16,.75*(2**attempt)))
        raise RuntimeError(f'teacher failed: {error}')
    return cache.call(key,request)

def valid(c):
    active=c.get('active_clauses')
    return c.get('route') in ROUTES and c.get('authority') in AUTH and c.get('context') in CONTEXT and isinstance(c.get('compound'),bool) and isinstance(active,int) and 0<=active<=6 and (c['route']!='compound' or c['compound']) and (not c['compound'] or active>=2)
def reject(c,source,seen,holdout,max_copy):
    text=str(c.get('prompt','')).strip(); normalized=canon(text)
    if not text: return 'empty'
    if not valid(c): return 'invalid-labels'
    if c['route']!=source['route']: return 'route-drift'
    if normalized in holdout: return 'frozen-exact'
    if normalized in seen: return 'duplicate'
    if jaccard(text,source['prompt'])>max_copy: return 'near-copy'
    return None

def generation_messages(batch,samples,style):
    sources=[{'source_id':i,'route':r['route'],'prompt':r['prompt'],'authority':r.get('authority','allow'),'context':r.get('context','ready')} for i,r in enumerate(batch)]
    system=f"Create hard supervision for Archie's routes {ROUTES}. Return structured final labels only, no chain-of-thought. Authority {AUTH}; context {CONTEXT}. JSON only."
    request=f'''Produce up to {samples} meaning-preserving {style} rewrites per source. Target {FAILURES}. Include negated/corrected clauses, punctuation and before-ordering, safe security documentation, vague references, and memory-current-operation conflicts. Do not copy wording or invent authority. Metadata is allowed only when the prompt explicitly refers to it. Sources: {json.dumps(sources,ensure_ascii=False)}. Return {{"candidates":[{{"source_id":0,"prompt":"...","route":"summary","authority":"allow","context":"ready","active_clauses":1,"compound":false,"operation":"summarize","target":"report","failure_family":"{FAILURES[0]}","attachments":[],"memory":"","reply_to":""}}]}}.'''
    return [{'role':'system','content':system},{'role':'user','content':request}]
def route_messages(c,replica):
    system=f'Independently label this Archie request. Ignore prior labels. Return JSON only, no reasoning. Verifier {replica}.'
    request=f'''Request: {c['prompt']} Allowed routes {ROUTES}; authority {AUTH}; context {CONTEXT}. Return {{"route":"...","authority":"allow","context":"ready","active_clauses":1,"compound":false,"confidence":0.0}}.'''
    return [{'role':'system','content':system},{'role':'user','content':request}]
def fidelity_messages(source,c,replica):
    system=f'Judge semantic fidelity. Return JSON only, no reasoning. Verifier {replica}.'
    request=f'''Source: {source['prompt']} Candidate: {c['prompt']} Preserve operation, target, authority, context, active/negated clauses, and outcome order/count? Return {{"faithful":true,"confidence":0.0}}.'''
    return [{'role':'system','content':system},{'role':'user','content':request}]
def consensus(c,routes,fidelity,min_conf):
    need=len(routes)//2+1; key=(c['route'],c['authority'],c['context'],c['active_clauses'],c['compound'])
    match=sum((v.get('route'),v.get('authority'),v.get('context'),v.get('active_clauses'),v.get('compound'))==key for v in routes)
    faithful=sum(bool(v.get('faithful')) for v in fidelity)
    conf=[float(v.get('confidence',0)) for v in routes+fidelity]
    return match>=need and faithful>=need and sum(conf)/max(1,len(conf))>=min_conf

def main():
    p=argparse.ArgumentParser(); p.add_argument('--data',required=True); p.add_argument('--out',required=True)
    p.add_argument('--endpoint',default='https://api.moonshot.ai/v1'); p.add_argument('--model',default='kimi-k2.6'); p.add_argument('--api-key-env',default='MOONSHOT_API_KEY')
    p.add_argument('--samples-per-row',type=int,default=4); p.add_argument('--judges',type=int,default=3); p.add_argument('--batch-size',type=int,default=8); p.add_argument('--max-sources',type=int,default=0); p.add_argument('--max-additions-per-route',type=int,default=4000)
    p.add_argument('--min-confidence',type=float,default=.72); p.add_argument('--max-source-jaccard',type=float,default=.82); p.add_argument('--timeout',type=int,default=180); p.add_argument('--retries',type=int,default=4); p.add_argument('--cache'); p.add_argument('--freeze',action='append',default=[]); p.add_argument('--thinking',action='store_true')
    p.add_argument('--reasoning-effort',choices=['low','high','max'],default=None,help='Kimi K3 reasoning effort; defaults to low, or max with --thinking')
    args=p.parse_args(); args.api_key=os.getenv(args.api_key_env) or os.getenv('ARCHIE_TEACHER_KEY')
    if not args.api_key: raise RuntimeError(f'missing API key in {args.api_key_env} or ARCHIE_TEACHER_KEY')
    rows=[{**r,'prompt':user_text(r)} for r in load(args.data) if r.get('route') in ROUTES and user_text(r)]
    if args.max_sources: rows=rows[:args.max_sources]
    holdout=frozen(args.freeze)
    if any(canon(r['prompt']) in holdout for r in rows): raise RuntimeError('training source overlaps frozen evaluation')
    cache=Cache(args.cache); seen={canon(r['prompt']) for r in rows}|holdout; accepted=[]; rejected=[]; per_route=Counter(); families=Counter()
    for start in range(0,len(rows),max(1,args.batch_size)):
        batch=rows[start:start+max(1,args.batch_size)]; style=STYLES[(start//max(1,args.batch_size))%len(STYLES)]
        try: candidates=teacher(args,cache,generation_messages(batch,args.samples_per_row,style),.8,4096).get('candidates',[])
        except Exception as exc: rejected.append({'batch':start,'reason':str(exc)}); continue
        for c in candidates:
            sid=c.get('source_id')
            if not isinstance(sid,int) or not 0<=sid<len(batch): rejected.append({'batch':start,'reason':'source-id'}); continue
            source=batch[sid]; reason=reject(c,source,seen,holdout,args.max_source_jaccard)
            if reason or per_route[c.get('route')]>=args.max_additions_per_route: rejected.append({'source':start+sid,'reason':reason or 'route-cap'}); continue
            rv=[]; fv=[]
            for j in range(args.judges):
                try:
                    rv.append(teacher(args,cache,route_messages(c,j+1),0,768)); fv.append(teacher(args,cache,fidelity_messages(source,c,j+1),0,512))
                except Exception: rv.append({'confidence':0}); fv.append({'faithful':False,'confidence':0})
            if not consensus(c,rv,fv,args.min_confidence): rejected.append({'source':start+sid,'reason':'verifier'}); continue
            seen.add(canon(c['prompt'])); per_route[c['route']]+=1; family=c.get('failure_family') if c.get('failure_family') in FAILURES else 'other'; families[family]+=1
            accepted.append({**source,**c,'route':source['route'],'distillation':{'method':'failure-directed-structured-consensus/v2','teacher':args.model,'source_digest':digest({'route':source['route'],'prompt':source['prompt']}),'route_consensus':sum(v.get('route')==source['route'] for v in rv),'fidelity_consensus':sum(bool(v.get('faithful')) for v in fv)}})
    output=rows+accepted; out=Path(args.out); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
    body={'schema':'archie-route-kimi-distill/v1','teacher':args.model,'endpoint_host':re.sub(r'^https?://','',args.endpoint).split('/')[0],'source_rows':len(rows),'accepted_rows':len(accepted),'rejected_rows':len(rejected),'route_additions':dict(per_route),'failure_family_additions':dict(families),'frozen_prompt_count':len(holdout),'output_digest':digest(output),'promotion':'not-admitted','claim_boundary':'Teacher-consensus training material only; not independent evidence of improvement or admission.'}
    receipt={**body,'receipt_digest':digest(body)}; Path(str(out)+'.receipt.json').write_text(json.dumps(receipt,indent=2)+'\n'); print(json.dumps(receipt,indent=2))
if __name__=='__main__': main()
