#!/usr/bin/env python3
from __future__ import annotations
import argparse, collections, json
from pathlib import Path
from typing import Any
import torch
from cognitive_router_app import ArchieCognitiveApp
from train_cognitive_router import AUTHORITY, CONTEXT, ROUTES, bencode, pad


def attachment_text(attachments: Any) -> str:
    if isinstance(attachments, list):
        pieces=[]
        for item in attachments:
            if isinstance(item, dict): pieces.append(str(item.get('name') or item.get('filename') or item.get('mime') or 'attachment'))
            else: pieces.append(str(item))
        return ' | '.join(pieces)
    return str(attachments or '')

def key(request, attachments, memory, thread):
    return (request, attachment_text(attachments), str(memory or ''), str(thread or ''))

def batch_neural(app: ArchieCognitiveApp, keys: list[tuple[str,str,str,str]], batch_size: int=128):
    result={}
    for start in range(0,len(keys),batch_size):
        chunk=keys[start:start+batch_size]; batch={}
        for index,name in enumerate(('request','attachment','memory','thread')):
            limit=app.config.max_request if name=='request' else app.config.max_payload
            values=[]
            for item in chunk:
                text=item[index]
                if name!='request' and not text: text='<absent>'
                values.append(bencode(text,limit))
            batch[name],batch[f'{name}_mask']=pad(values)
        with torch.inference_mode():
            route_logits,auth_logits,context_logits=app.model(batch)
            route_probs=torch.softmax(route_logits/max(.05,app.temperature),-1)
            auth_probs=torch.softmax(auth_logits,-1)
            context_probs=torch.softmax(context_logits,-1)
        for i,k in enumerate(chunk):
            rp,ap,cp=route_probs[i],auth_probs[i],context_probs[i]
            order=torch.argsort(rp,descending=True)[:3]
            alternatives=[{'route':ROUTES[int(j)],'confidence':float(rp[int(j)])} for j in order]
            result[k]=(ROUTES[int(rp.argmax())],float(rp.max()),AUTHORITY[int(ap.argmax())],float(ap.max()),CONTEXT[int(cp.argmax())],float(cp.max()),alternatives)
    return result

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--model',required=True); ap.add_argument('--data',required=True); ap.add_argument('--out',required=True); args=ap.parse_args()
    torch.set_num_threads(max(1,min(8,torch.get_num_threads())))
    app=ArchieCognitiveApp(args.model); rows=json.loads(Path(args.data).read_text())
    unique={}
    for row in rows:
        base=key(row['request'],row.get('attachments',[]),row.get('memory',''),row.get('thread','')); unique[base]=None
        active=app.active_text(row['request'])
        for clause in app.split_ordered(active): unique[key(clause,row.get('attachments',[]),row.get('memory',''),row.get('thread',''))]=None
    cache=batch_neural(app,list(unique))
    app._neural=lambda request,attachments,memory,thread: cache[key(request,attachments,memory,thread)]
    errors=[]; cats=collections.defaultdict(lambda:{'correct':0,'examples':0}); confidences=[]
    for row in rows:
        p=app.predict(row['request'],row.get('attachments',[]),row.get('memory',''),row.get('thread',''))
        expected=row['expected']; ok=(p.route==expected['route'] and p.authority==expected['authority'] and p.context==expected['context'] and p.outcomes==expected['outcomes'])
        cats[row['category']]['examples']+=1; cats[row['category']]['correct']+=int(ok); confidences.append({'correct':ok,'confidence':p.confidence})
        if not ok: errors.append({'id':row['id'],'category':row['category'],'request':row['request'],'expected':expected,'actual':p.__dict__})
    correct=len(rows)-len(errors); correct_conf=[x['confidence'] for x in confidences if x['correct']]; wrong_conf=[x['confidence'] for x in confidences if not x['correct']]
    result={'schema':'archie-postfreeze-evaluation/v10','examples':len(rows),'correct':correct,'accuracy':correct/len(rows),'unique_neural_calls':len(unique),'categories':{k:{**v,'accuracy':v['correct']/v['examples']} for k,v in sorted(cats.items())},'calibration':{'mean_correct_confidence':sum(correct_conf)/max(1,len(correct_conf)),'mean_wrong_confidence':sum(wrong_conf)/max(1,len(wrong_conf))},'errors':errors,'promotion':'not-admitted'}
    Path(args.out).write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps({k:v for k,v in result.items() if k!='errors'},indent=2)); print('errors',len(errors))
if __name__=='__main__': main()
