"""Shared contracts and context projection for Archie Kimi distillation."""
from __future__ import annotations
import hashlib, json, re
from pathlib import Path
from typing import Any

ROUTES=['checklist','clarify','compound','decision','errands','event','message','next_action','objective','plan','study','summary']
AUTH=['allow','deny']; CONTEXT=['ready','missing','ambiguous']
FAILURES=['unseen-summary-decision-phrasing','safe-security-documentation','memory-operation-conflict','punctuation-and-before-compounds','vague-reference-abstention','negation-and-correction-clause-activity']
STYLES=['casual text message','spoken request with filler words','messy mobile dictation','polite request','urgent informal request','context-dependent follow-up']
TOKENS=re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")

def canon(value): return ' '.join(TOKENS.findall(str(value or '').lower().replace('’',"'")))
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def user_text(row):
    for key in ('text','prompt','request'):
        if isinstance(row.get(key),str) and row[key].strip(): return row[key].strip()
    for message in row.get('messages') or []:
        if not isinstance(message,dict) or message.get('role')!='user': continue
        value=message.get('content')
        if isinstance(value,str) and value.strip(): return value.strip()
        if isinstance(value,list):
            text=' '.join(part.get('text','') for part in value if isinstance(part,dict) and isinstance(part.get('text'),str)).strip()
            if text: return text
    return ''

def load(path):
    file=Path(path)
    if file.suffix=='.jsonl': return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
    value=json.loads(file.read_text())
    if isinstance(value,list): return value
    if isinstance(value,dict) and isinstance(value.get('rows'),list): return value['rows']
    raise ValueError(f'unsupported row container in {path}')

def expected(row):
    nested=row.get('expected') if isinstance(row.get('expected'),dict) else {}
    metadata=row.get('metadata') if isinstance(row.get('metadata'),dict) else {}
    raw_context=row.get('context')
    outcomes=row.get('outcomes') or nested.get('outcomes') or []
    return {'route':row.get('route') or nested.get('route'),'authority':row.get('authority') or nested.get('authority') or 'allow','context':raw_context if isinstance(raw_context,str) else nested.get('context') or 'ready','failure_family':row.get('failure_family') or metadata.get('failure_family'),'outcomes':outcomes if isinstance(outcomes,list) else []}

def source_row(row):
    labels=expected(row); prompt=user_text(row)
    if not prompt or labels['route'] not in ROUTES or labels['authority'] not in AUTH or labels['context'] not in CONTEXT or labels['failure_family'] not in FAILURES: return None
    context_value=row.get('context') if isinstance(row.get('context'),dict) else {}
    normalized={**row,**labels,'prompt':prompt}
    normalized['attachments']=row.get('attachments') or row.get('files') or row.get('attached_files') or []
    normalized['memory']=row.get('memory') or row.get('memories') or context_value.get('memory') or ''
    normalized['thread']=row.get('thread') or row.get('reply_to') or context_value.get('thread') or ''
    return normalized

def frozen(paths):
    return sorted(set(canon(user_text(row)) for path in paths if Path(path).exists() for row in load(path) if user_text(row)))

def jaccard(first,second):
    left,right=set(canon(first).split()),set(canon(second).split()); return len(left&right)/max(1,len(left|right))
def near_any(text,candidates,threshold): return threshold>0 and any(jaccard(text,candidate)>=threshold for candidate in candidates)
def endpoint(base):
    base=base.rstrip('/')
    if base.endswith('/chat/completions'): return base
    return base+'/chat/completions' if base.endswith('/v1') else base+'/v1/chat/completions'
def trim_text(value,limit):
    text=str(value or '').strip(); return text if len(text)<=limit else text[:limit]+'…'
def attachment_projection(value):
    if not isinstance(value,list): return []
    result=[]
    for item in value[:4]:
        if isinstance(item,str): result.append({'name':trim_text(item,160),'type':''})
        elif isinstance(item,dict): result.append({'name':trim_text(item.get('name') or item.get('filename') or '',160),'type':trim_text(item.get('type') or item.get('mime_type') or '',80)})
    return result
def memory_projection(value): return [trim_text(item,240) for item in value[:3]] if isinstance(value,list) else trim_text(value,720)
def context_projection(row): return {'attachments':attachment_projection(row.get('attachments')),'memory':memory_projection(row.get('memory')),'thread':trim_text(row.get('thread'),720)}

def object_schema(properties,required): return {'type':'object','properties':properties,'required':required,'additionalProperties':False}
def generation_schema(batch_size,samples):
    candidate=object_schema({'source_id':{'type':'integer','minimum':0,'maximum':max(0,batch_size-1)},'prompt':{'type':'string','minLength':1,'maxLength':1200},'route':{'type':'string','enum':ROUTES},'authority':{'type':'string','enum':AUTH},'context':{'type':'string','enum':CONTEXT},'active_clauses':{'type':'integer','minimum':0,'maximum':6},'compound':{'type':'boolean'},'operation':{'type':'string','minLength':1,'maxLength':160},'target':{'type':'string','minLength':1,'maxLength':240},'ordered_outcomes':{'type':'array','maxItems':6,'items':{'type':'string','minLength':1,'maxLength':200}},'failure_family':{'type':'string','enum':FAILURES}},['source_id','prompt','route','authority','context','active_clauses','compound','operation','target','ordered_outcomes','failure_family'])
    return object_schema({'candidates':{'type':'array','minItems':0,'maxItems':batch_size*samples,'items':candidate}},['candidates'])
def verifier_schema(candidate_ids):
    verdict=object_schema({'candidate_id':{'type':'string','enum':candidate_ids},'route':{'type':'string','enum':ROUTES},'authority':{'type':'string','enum':AUTH},'context':{'type':'string','enum':CONTEXT},'active_clauses':{'type':'integer','minimum':0,'maximum':6},'compound':{'type':'boolean'},'faithful':{'type':'boolean'},'authority_preserved':{'type':'boolean'},'context_preserved':{'type':'boolean'},'ordered_outcomes_preserved':{'type':'boolean'},'negation_preserved':{'type':'boolean'},'confidence':{'type':'number','minimum':0,'maximum':1}},['candidate_id','route','authority','context','active_clauses','compound','faithful','authority_preserved','context_preserved','ordered_outcomes_preserved','negation_preserved','confidence'])
    return object_schema({'verdicts':{'type':'array','minItems':len(candidate_ids),'maxItems':len(candidate_ids),'items':verdict}},['verdicts'])
def response_format(mode,name,schema): return {'type':'json_schema','json_schema':{'name':name,'strict':True,'schema':schema}} if mode=='json_schema' else {'type':'json_object'}
