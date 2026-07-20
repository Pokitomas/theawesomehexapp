"""HTTP, caching, and Kimi request construction for Archie distillation."""
from __future__ import annotations
import json, time, urllib.request
from pathlib import Path
from kimi_distill_common import digest, endpoint, response_format

class Cache:
    def __init__(self,path):
        self.path=Path(path) if path else None; self.data={}; self.hits=0; self.misses=0
        if self.path and self.path.exists():
            for line in self.path.read_text().splitlines():
                if line.strip():
                    row=json.loads(line); self.data[row['key']]=row['value']
    def call(self,key,function):
        if key in self.data: self.hits+=1; return self.data[key]
        self.misses+=1; value=function(); self.data[key]=value
        if self.path:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            with self.path.open('a') as file: file.write(json.dumps({'key':key,'value':value},ensure_ascii=False)+'\n')
        return value

class ApiStats:
    def __init__(self): self.logical_generation=0; self.logical_verification=0; self.http_attempts=0; self.http_successes=0

def request_body(args,messages,temperature,max_completion_tokens,schema_name,schema):
    body={'model':args.model,'messages':messages,'response_format':response_format(args.structured_output,schema_name,schema),'max_completion_tokens':max_completion_tokens}
    model=args.model.lower(); is_k3='kimi-k3' in model or 'kimi_k3' in model or model in {'k3','kimi/k3'} or model.endswith('/k3')
    if is_k3: body['reasoning_effort']=args.reasoning_effort or ('max' if args.thinking else 'low')
    else:
        body['temperature']=temperature
        if 'kimi' in model: body['thinking']={'type':'enabled' if args.thinking else 'disabled'}
    return body

def teacher(args,cache,stats,messages,temperature,max_completion_tokens,schema_name,schema):
    body=request_body(args,messages,temperature,max_completion_tokens,schema_name,schema); key=digest({'endpoint':endpoint(args.endpoint),**body})
    def request():
        req=urllib.request.Request(endpoint(args.endpoint),data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':f'Bearer {args.api_key}'})
        error=None
        for attempt in range(args.retries+1):
            stats.http_attempts+=1
            try:
                with urllib.request.urlopen(req,timeout=args.timeout) as response: payload=json.load(response)
                stats.http_successes+=1; content=payload['choices'][0]['message']['content']
                if not isinstance(content,str): raise ValueError('teacher message.content is not a string')
                parsed=json.loads(content)
                if not isinstance(parsed,dict): raise ValueError('teacher final content is not a JSON object')
                return parsed
            except Exception as exception:
                error=exception
                if attempt<args.retries: time.sleep(min(16,.75*(2**attempt)))
        raise RuntimeError(f'teacher failed: {error}')
    return cache.call(key,request)
