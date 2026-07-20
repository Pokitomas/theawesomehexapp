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
def verifier_messages(batch,candidates,replica):
    entries=[]
    for candidate in candidates:
        source=batch[candidate['_source_id']]
        entries.append({
            'candidate_id':candidate['_candidate_id'],
            'source':{
                'prompt':source['prompt'],
                'route':source['route'],
                'authority':source.get('authority','allow'),
                'context':source.get('context','ready'),
            },
            'candidate':{key:candidate.get(key) for key in (
                'prompt','route','authority','context','active_clauses','compound',
                'operation','target','failure_family')},
        })
    system=f'''Independently verify Archie distillation candidates. Allowed routes: {ROUTES}; authority: {AUTH}; context: {CONTEXT}. Treat each candidate_id as an isolated record. Never transfer facts, labels, memory, attachments, or clauses between records. Return JSON only and no reasoning.'''
    request=f'''Verifier replica {replica}. For each record, independently relabel the candidate request and judge whether it faithfully preserves its own source operation, target, authority, context, active/negated clauses, and ordered outcome count. Return exactly one verdict for every candidate_id and no unknown IDs. Records: {json.dumps(entries,ensure_ascii=False)}. Return {{"verdicts":[{{"candidate_id":"0:0","route":"summary","authority":"allow","context":"ready","active_clauses":1,"compound":false,"faithful":true,"confidence":0.0}}]}}.'''
    return [{'role':'system','content':system},{'role':'user','content':request}]

def index_verdicts(candidates,payload):
    expected={candidate['_candidate_id'] for candidate in candidates}
    verdicts=payload.get('verdicts',[]) if isinstance(payload,dict) else []
    result={}
    for verdict in verdicts:
        candidate_id=verdict.get('candidate_id') if isinstance(verdict,dict) else None
        if candidate_id not in expected or candidate_id in result:
            return None
        result[candidate_id]=verdict
    return result if set(result)==expected else None

def batch_consensus(candidate,verdicts,min_conf):
    need=len(verdicts)//2+1
    key=(candidate['route'],candidate['authority'],candidate['context'],candidate['active_clauses'],candidate['compound'])
    matches=sum((v.get('route'),v.get('authority'),v.get('context'),v.get('active_clauses'),v.get('compound'))==key for v in verdicts)
    faithful=sum(bool(v.get('faithful')) for v in verdicts)
    confidence=sum(float(v.get('confidence',0)) for v in verdicts)/max(1,len(verdicts))
    return matches>=need and faithful>=need and confidence>=min_conf

def main():
    p=argparse.ArgumentParser(); p.add_argument('--data',required=True); p.add_argument('--out',required=True)
    p.add_argument('--endpoint',default='https://api.moonshot.ai/v1'); p.add_argument('--model',default='kimi-k2.6'); p.add_argument('--api-key-env',default='MOONSHOT_API_KEY')
    p.add_argument('--samples-per-row',type=int,default=4); p.add_argument('--judges',type=int,default=3); p.add_argument('--batch-size',type=int,default=8); p.add_argument('--max-sources',type=int,default=0); p.add_argument('--max-additions-per-route',type=int,default=4000)
    p.add_argument('--min-confidence',type=float,default=.72); p.add_argument('--max-source-jaccard',type=float,default=.82); p.add_argument('--timeout',type=int,default=180); p.add_argument('--retries',type=int,default=4); p.add_argument('--cache'); p.add_argument('--freeze',action='append',default=[]); p.add_argument('--thinking',action='store_true')
    p.add_argument('--reasoning-effort',choices=['low','high','max'],default=None,help='Kimi K3 reasoning effort; defaults to low, or max with --thinking')
    p.add_argument('--estimate-only',action='store_true',help='Print API-call and output-token-cap estimates without calling the teacher')
    args=p.parse_args(); args.api_key=os.getenv(args.api_key_env) or os.getenv('ARCHIE_TEACHER_KEY')
    rows=[{**r,'prompt':user_text(r)} for r in load(args.data) if r.get('route') in ROUTES and user_text(r)]
    if args.max_sources: rows=rows[:args.max_sources]
    generation_batches=(len(rows)+max(1,args.batch_size)-1)//max(1,args.batch_size)
    estimate={
        'sources':len(rows),
        'candidate_upper_bound':len(rows)*args.samples_per_row,
        'generation_calls':generation_batches,
        'verifier_calls_upper_bound':generation_batches*args.judges,
        'total_calls_upper_bound':generation_batches*(1+args.judges),
        'max_completion_tokens_exposure':generation_batches*(1+args.judges)*4096,
    }
    if args.estimate_only:
        print(json.dumps(estimate,indent=2)); return
    if not args.api_key: raise RuntimeError(f'missing API key in {args.api_key_env} or ARCHIE_TEACHER_KEY')
    holdout=frozen(args.freeze)
    if any(canon(r['prompt']) in holdout for r in rows): raise RuntimeError('training source overlaps frozen evaluation')
    cache=Cache(args.cache); seen={canon(r['prompt']) for r in rows}|holdout; accepted=[]; rejected=[]; per_route=Counter(); families=Counter()
    generation_calls=0; verifier_calls=0
    for start in range(0,len(rows),max(1,args.batch_size)):
        batch=rows[start:start+max(1,args.batch_size)]; style=STYLES[(start//max(1,args.batch_size))%len(STYLES)]
        try:
            candidates=teacher(args,cache,generation_messages(batch,args.samples_per_row,style),.8,4096).get('candidates',[])
            generation_calls+=1
        except Exception as exc:
            rejected.append({'batch':start,'reason':str(exc)}); continue
        pending=[]
        for position,candidate in enumerate(candidates):
            sid=candidate.get('source_id')
            if not isinstance(sid,int) or not 0<=sid<len(batch):
                rejected.append({'batch':start,'reason':'source-id'}); continue
            source=batch[sid]; reason=reject(candidate,source,seen,holdout,args.max_source_jaccard)
            if reason or per_route[candidate.get('route')]>=args.max_additions_per_route:
                rejected.append({'source':start+sid,'reason':reason or 'route-cap'}); continue
            pending.append({**candidate,'_source_id':sid,'_candidate_id':f'{start}:{position}'})
        if not pending: continue
        judge_maps=[]
        for judge in range(args.judges):
            try:
                payload=teacher(args,cache,verifier_messages(batch,pending,judge+1),0,4096)
                verifier_calls+=1
                indexed=index_verdicts(pending,payload)
            except Exception:
                indexed=None
            if indexed is None:
                rejected.extend({'source':start+c['_source_id'],'reason':f'verifier-isolation-{judge+1}'} for c in pending)
                judge_maps=[]; break
            judge_maps.append(indexed)
        if len(judge_maps)!=args.judges: continue
        for candidate in pending:
            source=batch[candidate['_source_id']]
            verdicts=[mapping[candidate['_candidate_id']] for mapping in judge_maps]
            if not batch_consensus(candidate,verdicts,args.min_confidence):
                rejected.append({'source':start+candidate['_source_id'],'reason':'verifier'}); continue
            text=canon(candidate['prompt'])
            if text in seen or per_route[candidate['route']]>=args.max_additions_per_route:
                rejected.append({'source':start+candidate['_source_id'],'reason':'post-verifier-duplicate-or-cap'}); continue
            seen.add(text); per_route[candidate['route']]+=1
            family=candidate.get('failure_family') if candidate.get('failure_family') in FAILURES else 'other'; families[family]+=1
            cleaned={key:value for key,value in candidate.items() if not key.startswith('_')}
            accepted.append({**source,**cleaned,'route':source['route'],'distillation':{'method':'failure-directed-batched-consensus/v3','teacher':args.model,'source_digest':digest({'route':source['route'],'prompt':source['prompt']}),'verifier_consensus':sum(v.get('route')==source['route'] and bool(v.get('faithful')) for v in verdicts)}})
    output=rows+accepted; out=Path(args.out); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
    body={'schema':'archie-route-kimi-distill/v1','teacher':args.model,'endpoint_host':re.sub(r'^https?://','',args.endpoint).split('/')[0],'source_rows':len(rows),'accepted_rows':len(accepted),'rejected_rows':len(rejected),'route_additions':dict(per_route),'failure_family_additions':dict(families),'frozen_prompt_count':len(holdout),'api_calls':{'generation':generation_calls,'verification':verifier_calls},'preflight_estimate':estimate,'output_digest':digest(output),'promotion':'not-admitted','claim_boundary':'Teacher-consensus training material only; not independent evidence of improvement or admission.'}
    receipt={**body,'receipt_digest':digest(body)}; Path(str(out)+'.receipt.json').write_text(json.dumps(receipt,indent=2)+'\n'); print(json.dumps(receipt,indent=2))
if __name__=='__main__': main()
