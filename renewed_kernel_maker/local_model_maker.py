from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import canonical, receipt
import study_index

SCHEMA="archie-local-maker/v2"
MAX_FILE_BYTES=2_000_000
MAX_TOOL_STEPS=64

@dataclass(frozen=True)
class RuntimeConfig:
    endpoint:str="http://127.0.0.1:8080/v1/chat/completions"
    model:str="local-model"
    timeout_s:float=120.0
    temperature:float=0.15
    max_tokens:int=8192
    study_db:str=""

@dataclass(frozen=True)
class ToolEvent:
    step:int; tool:str; args:dict[str,Any]; ok:bool; evidence:dict[str,Any]

SYSTEM=r'''You are the resident local full-stack application maker. Work inside the supplied project workspace and produce complete runnable software, not prose or sketches. You may study the indexed approved corpus when useful.
Return exactly one JSON object per response:
{"tool":"write_file","args":{"path":"relative/path","content":"..."}}
{"tool":"read_file","args":{"path":"relative/path"}}
{"tool":"list_files","args":{}}
{"tool":"study_search","args":{"query":"voxel collision raycast","limit":6}}
{"tool":"run","args":{"argv":["program","arg1"],"timeout_s":20}}
{"tool":"finish","args":{"summary":"..."}}
Use relative paths. Never escape the workspace. Never use shell=True or network commands. Do not access secrets. Use study results as reference knowledge, not copy-by-default. Run checks yourself, inspect failures, repair them, and finish only when the app is genuinely runnable. For held-out evaluation, implement from the brief rather than assuming a hidden reference template exists.'''

def _safe_path(root:Path,rel:str)->Path:
    rel=str(rel or "").replace("\\","/").lstrip("/")
    if not rel or "\x00" in rel: raise ValueError("invalid path")
    p=(root/rel).resolve(); rr=root.resolve()
    if p!=rr and rr not in p.parents: raise ValueError("path escapes workspace")
    return p

def _json_from_text(text:str)->dict[str,Any]:
    text=text.strip()
    try:
        v=json.loads(text)
        if isinstance(v,dict): return v
    except Exception: pass
    m=re.search(r"\{.*\}",text,flags=re.S)
    if not m: raise ValueError("model response contained no JSON object")
    v=json.loads(m.group(0))
    if not isinstance(v,dict): raise ValueError("model response JSON must be object")
    return v

def probe(config:RuntimeConfig)->dict[str,Any]:
    req=urllib.request.Request(config.endpoint,data=json.dumps({"model":config.model,"messages":[{"role":"user","content":"Reply with exactly {\"ok\":true}."}],"temperature":0,"max_tokens":32}).encode(),headers={"Content-Type":"application/json"},method="POST")
    try:
        t0=time.perf_counter()
        with urllib.request.urlopen(req,timeout=min(config.timeout_s,10)) as r: raw=r.read().decode("utf-8","replace"); status=r.status
        return receipt("local_model.probe",{"status":"READY","http":status,"elapsed_ms":(time.perf_counter()-t0)*1000,"body_prefix":raw[:500]})
    except Exception as exc: return receipt("local_model.probe",{"status":"BLOCKED","reason":f"{type(exc).__name__}: {exc}"})

def complete(config:RuntimeConfig,messages:list[dict[str,str]])->tuple[str,dict[str,Any]]:
    payload={"model":config.model,"messages":messages,"temperature":config.temperature,"max_tokens":config.max_tokens}
    req=urllib.request.Request(config.endpoint,data=json.dumps(payload).encode(),headers={"Content-Type":"application/json"},method="POST"); t0=time.perf_counter()
    with urllib.request.urlopen(req,timeout=config.timeout_s) as r: raw=r.read().decode("utf-8","replace"); status=r.status
    obj=json.loads(raw); return str(obj["choices"][0]["message"]["content"]),{"http":status,"elapsed_ms":(time.perf_counter()-t0)*1000,"usage":obj.get("usage") or {}}

def execute_tool(root:Path,tool:str,args:dict[str,Any],*,study_db:str="")->tuple[bool,dict[str,Any]]:
    if tool=="write_file":
        p=_safe_path(root,str(args.get("path") or "")); b=str(args.get("content") or "").encode("utf-8")
        if len(b)>MAX_FILE_BYTES:return False,{"error":"file_too_large","bytes":len(b)}
        p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(b); return True,{"path":p.relative_to(root).as_posix(),"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()}
    if tool=="read_file":
        p=_safe_path(root,str(args.get("path") or ""))
        if not p.is_file():return False,{"error":"not_found","path":str(args.get("path"))}
        b=p.read_bytes(); return True,{"path":p.relative_to(root).as_posix(),"bytes":len(b),"content":b[:100_000].decode("utf-8","replace")}
    if tool=="list_files":
        files=[{"path":p.relative_to(root).as_posix(),"bytes":p.stat().st_size} for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts]
        return True,{"files":files[:1000]}
    if tool=="study_search":
        if not study_db:return False,{"error":"study_index_not_configured"}
        db=Path(study_db)
        if not db.is_file():return False,{"error":"study_index_missing","path":study_db}
        try:return True,study_index.search(db,str(args.get("query") or ""),limit=max(1,min(20,int(args.get("limit") or 6))),max_chars=12000)
        except Exception as exc:return False,{"error":f"study_search:{type(exc).__name__}: {exc}"}
    if tool=="run":
        argv=args.get("argv")
        if not isinstance(argv,list) or not argv or not all(isinstance(x,str) for x in argv):return False,{"error":"argv_required"}
        exe=shutil.which(argv[0])
        if not exe:return False,{"error":"executable_missing","program":argv[0]}
        denied={"curl","wget","ssh","scp","nc","ncat","powershell","pwsh","git"}
        if Path(exe).name.lower() in denied:return False,{"error":"network_or_external_control_command_denied","program":argv[0]}
        timeout_s=max(1.0,min(60.0,float(args.get("timeout_s") or 20)))
        try:
            p=subprocess.run([exe,*argv[1:]],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout_s,env={**os.environ,"NO_PROXY":"*","no_proxy":"*"})
            return p.returncode==0,{"argv":argv,"returncode":p.returncode,"stdout":p.stdout[-12000:]}
        except subprocess.TimeoutExpired as exc:return False,{"error":"timeout","stdout":(exc.stdout or "")[-12000:] if isinstance(exc.stdout,str) else ""}
    return False,{"error":"unknown_tool","tool":tool}

def project_digest(root:Path)->dict[str,Any]:
    files=[]; h=hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if not p.is_file() or ".git" in p.parts:continue
        rel=p.relative_to(root).as_posix(); b=p.read_bytes(); fh=hashlib.sha256(b).hexdigest(); files.append({"path":rel,"bytes":len(b),"sha256":fh}); h.update(rel.encode()+b"\0"+fh.encode()+b"\n")
    return {"sha256":h.hexdigest(),"files":files,"bytes":sum(x["bytes"] for x in files)}

def run_maker(config:RuntimeConfig,brief:str,root:Path,*,max_steps:int=MAX_TOOL_STEPS,record_approved_brief:bool=False)->dict[str,Any]:
    root.mkdir(parents=True,exist_ok=True)
    study_note=" Approved study index is available via study_search." if config.study_db else ""
    messages=[{"role":"system","content":SYSTEM},{"role":"user","content":"PROJECT BRIEF:\n"+brief+"\nWorkspace starts empty. Build, verify, and finish the project."+study_note}]
    events=[]; model_meta=[]; status="STEP_LIMIT"; summary=""
    for step in range(1,max(1,min(128,int(max_steps)))+1):
        try:text,meta=complete(config,messages); model_meta.append(meta); call=_json_from_text(text)
        except Exception as exc:status="MODEL_ERROR"; events.append(ToolEvent(step,"model",{},False,{"error":f"{type(exc).__name__}: {exc}"})); break
        tool=str(call.get("tool") or ""); args=call.get("args") if isinstance(call.get("args"),dict) else {}
        if tool=="finish":status="FINISHED"; summary=str(args.get("summary") or ""); events.append(ToolEvent(step,tool,args,True,{"summary":summary})); break
        ok,evidence=execute_tool(root,tool,args,study_db=config.study_db); events.append(ToolEvent(step,tool,args,ok,evidence)); messages.append({"role":"assistant","content":json.dumps(call,separators=(",",":"))}); messages.append({"role":"user","content":"TOOL RESULT:\n"+json.dumps({"ok":ok,"evidence":evidence},ensure_ascii=False)[:30000]})
    digest=project_digest(root); ev=[asdict(e) for e in events]
    payload={"schema":SCHEMA,"status":status,"brief_sha256":hashlib.sha256(brief.encode()).hexdigest(),"model":asdict(config),"steps":len(events),"events":ev,"summary":summary,"project":digest,"trajectory_sha256":hashlib.sha256(canonical(ev)).hexdigest(),"model_calls":model_meta}
    if record_approved_brief:payload["approved_brief"]=brief
    return receipt("local_maker.run",payload)

def court()->dict[str,Any]:
    with tempfile.TemporaryDirectory(prefix="archie-local-maker-") as td:
        root=Path(td); ok1,_=execute_tool(root,"write_file",{"path":"src/a.txt","content":"hello"}); ok2,r=execute_tool(root,"read_file",{"path":"src/a.txt"}); escaped=False
        try:execute_tool(root,"write_file",{"path":"../escape.txt","content":"bad"})
        except ValueError:escaped=True
        d1=project_digest(root); d2=project_digest(root); p=probe(RuntimeConfig(endpoint="http://127.0.0.1:1/v1/chat/completions",timeout_s=.1)); missing_ok,missing=execute_tool(root,"study_search",{"query":"voxel"})
        passes=ok1 and ok2 and r.get("content")=="hello" and escaped and d1==d2 and p["payload"]["status"]=="BLOCKED" and not missing_ok and missing.get("error")=="study_index_not_configured"
        return receipt("local_maker.court",{"passes":passes,"workspace_escape_refused":escaped,"digest_deterministic":d1==d2,"runtime_absence_honest":p["payload"]["status"]=="BLOCKED","study_requires_explicit_index":not missing_ok})
if __name__=="__main__":print(json.dumps(court(),indent=2))
