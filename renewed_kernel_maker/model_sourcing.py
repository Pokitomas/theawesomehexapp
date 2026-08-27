from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from typing import Any

from core import canonical, receipt

@dataclass(frozen=True)
class ModelCandidate:
    name:str
    source:str
    weights:str
    params_b:float
    active_b:float|None
    context:int
    tool_use:bool
    local_vram_gib_estimate:float
    teacher_only:bool=False
    notes:str=''

DEFAULTS=(
    ModelCandidate('GLM-5.3-Flash','zai-org/GLM-5.3-Flash','open',320,18,1_000_000,True,180.0,True,'ox-alpha identity; large teacher'),
    ModelCandidate('Qwen-family-local','runtime-resolved','open',27,None,32768,True,18.0,False,'quantize for local inference'),
    ModelCandidate('small-maker-student','local-training','derived',0.024,None,8192,True,0.5,False,'research student target'),
)

def rank(c:ModelCandidate,*,vram_gib:float,needs_training:bool=False)->float:
    fit=1.0 if c.local_vram_gib_estimate<=vram_gib else max(0.0,vram_gib/max(.1,c.local_vram_gib_estimate))
    score=4*fit+2*int(c.tool_use)+min(2.0,c.context/32768)-2*int(c.teacher_only and needs_training)
    return round(score,6)

def plan(*,vram_gib:float,disk_gib:float,candidates=DEFAULTS)->dict[str,Any]:
    ranked=sorted(({'candidate':asdict(c),'score':rank(c,vram_gib=vram_gib)} for c in candidates),key=lambda x:(-x['score'],x['candidate']['name']))
    teacher=next((x for x in ranked if x['candidate']['teacher_only']),None)
    local=next((x for x in ranked if not x['candidate']['teacher_only'] and x['candidate']['local_vram_gib_estimate']<=vram_gib),None)
    strategy={
        'local_runtime':local['candidate']['name'] if local else 'quantized-or-smaller-model-required',
        'teacher':teacher['candidate']['name'] if teacher else None,
        'distillation':['behavior-trajectories','tool-call-traces','preference-pairs','logits-if-observable','representations-if-observable'],
        'triton':'only after torch/reference equivalence and measured speedup',
        'full_teacher_local':bool(teacher and teacher['candidate']['local_vram_gib_estimate']<=vram_gib and disk_gib>=220),
    }
    body={'vram_gib':vram_gib,'disk_gib':disk_gib,'ranked':ranked,'strategy':strategy}; body['sha256']=hashlib.sha256(canonical(body)).hexdigest(); return body

def court()->dict[str,Any]:
    p=plan(vram_gib=6,disk_gib=100)
    return receipt('model_sourcing.court',{'passes':p['strategy']['full_teacher_local'] is False and p['strategy']['local_runtime']!='GLM-5.3-Flash','strategy':p['strategy'],'sha256':p['sha256']})

if __name__=='__main__': print(json.dumps(court(),indent=2))
