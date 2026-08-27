from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from core import receipt
from local_model_maker import RuntimeConfig, probe, run_maker
from voxel_heldout import grade
import study_index

HERE=Path(__file__).resolve().parent
IDE_ROOT=HERE/"maker_ide"

class State:
    def __init__(self,workspace:Path,config:RuntimeConfig):
        self.workspace=workspace.resolve(); self.config=config; self.lock=threading.Lock(); self.runs={}; self.workspace.mkdir(parents=True,exist_ok=True)
    def project_path(self,project_id:str)->Path:
        safe="".join(c for c in project_id if c.isalnum() or c in "-_")[:80]
        if not safe: raise ValueError("invalid project id")
        p=(self.workspace/safe).resolve()
        if self.workspace not in p.parents: raise ValueError("project escaped workspace")
        return p

def project_id_for(brief:str)->str:return "app-"+hashlib.sha256((str(time.time_ns())+"\0"+brief).encode()).hexdigest()[:12]

class Handler(BaseHTTPRequestHandler):
    server_version="ArchieMaker/2"
    @property
    def state(self)->State:return self.server.state  # type: ignore[attr-defined]
    def log_message(self,fmt,*args):print("MAKER_HTTP",self.address_string(),fmt%args)
    def send_json(self,value,status=200):
        body=json.dumps(value,indent=2,default=str).encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
    def send_file(self,path:Path):
        if not path.is_file():self.send_error(404);return
        body=path.read_bytes(); self.send_response(200); self.send_header("Content-Type",mimetypes.guess_type(path.name)[0] or "application/octet-stream"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
    def body_json(self,limit=2_000_000):
        n=int(self.headers.get("Content-Length") or 0)
        if n<0 or n>limit:raise ValueError("request body too large")
        v=json.loads(self.rfile.read(n) or b"{}");
        if not isinstance(v,dict):raise ValueError("JSON object required")
        return v
    def do_GET(self):
        u=urlparse(self.path)
        if u.path=="/api/status":
            p=probe(self.state.config); study=None
            if self.state.config.study_db and Path(self.state.config.study_db).is_file():
                try:study=study_index.stats(Path(self.state.config.study_db))
                except Exception as exc:study={"error":f"{type(exc).__name__}: {exc}"}
            self.send_json({"schema":"archie-maker-server/v2","model":p,"study":study,"workspace":str(self.state.workspace),"runs":list(self.state.runs.values())[-20:]});return
        if u.path=="/api/runs":self.send_json({"runs":list(self.state.runs.values())[-100:]});return
        if u.path.startswith("/api/project/"):
            parts=u.path.split("/"); project_id=parts[3] if len(parts)>3 else ""
            try:root=self.state.project_path(project_id)
            except ValueError as exc:self.send_json({"error":str(exc)},400);return
            if len(parts)==4 or not parts[4]:
                files=[]
                if root.exists():
                    files=[{"path":p.relative_to(root).as_posix(),"bytes":p.stat().st_size} for p in sorted(root.rglob("*")) if p.is_file()]
                self.send_json({"project_id":project_id,"files":files,"grade":grade(root)["payload"] if root.exists() else None});return
            rel=unquote("/".join(parts[4:])); p=(root/rel).resolve()
            if root!=p and root not in p.parents:self.send_error(403);return
            self.send_file(p);return
        if u.path.startswith("/preview/"):
            parts=u.path.split("/"); project_id=parts[2] if len(parts)>2 else ""
            try:root=self.state.project_path(project_id)
            except ValueError:self.send_error(400);return
            rel=unquote("/".join(parts[3:]) or "index.html"); p=(root/rel).resolve()
            if root!=p and root not in p.parents:self.send_error(403);return
            self.send_file(p);return
        rel="index.html" if u.path=="/" else unquote(u.path.lstrip("/")); p=(IDE_ROOT/rel).resolve(); ir=IDE_ROOT.resolve()
        if ir!=p and ir not in p.parents:self.send_error(403);return
        self.send_file(p)
    def do_POST(self):
        if urlparse(self.path).path!="/api/build":self.send_error(404);return
        try:body=self.body_json()
        except Exception as exc:self.send_json({"error":f"{type(exc).__name__}: {exc}"},400);return
        brief=str(body.get("brief") or "").strip()
        if len(brief)<12 or len(brief)>20_000:self.send_json({"error":"brief must be 12..20000 characters"},400);return
        pid=project_id_for(brief);root=self.state.project_path(pid);run_meta={"project_id":pid,"status":"RUNNING","brief_sha256":hashlib.sha256(brief.encode()).hexdigest(),"started_at":time.time()}
        with self.state.lock:self.state.runs[pid]=run_meta
        try:
            result=run_maker(self.state.config,brief,root,max_steps=int(body.get("max_steps") or 64),record_approved_brief=bool(body.get("record_for_training",False))); grading=grade(root);run_meta.update({"status":result["payload"]["status"],"finished_at":time.time(),"result":result,"grade":grading});self.send_json(receipt("maker_server.build",run_meta))
        except Exception as exc:run_meta.update({"status":"ERROR","finished_at":time.time(),"error":f"{type(exc).__name__}: {exc}"});self.send_json(receipt("maker_server.build",run_meta),500)

def serve(host:str,port:int,workspace:Path,config:RuntimeConfig):
    state=State(workspace,config);httpd=ThreadingHTTPServer((host,port),Handler);httpd.state=state  # type: ignore[attr-defined]
    print(json.dumps({"schema":"archie-maker-server/v2","url":f"http://{host}:{port}","workspace":str(state.workspace),"model":config.model,"endpoint":config.endpoint,"study_db":config.study_db or None}));httpd.serve_forever()

def main()->int:
    ap=argparse.ArgumentParser();ap.add_argument("--host",default="127.0.0.1");ap.add_argument("--port",type=int,default=8844);ap.add_argument("--workspace",type=Path,default=Path.home()/"archie-maker-projects");ap.add_argument("--endpoint",default=os.environ.get("ARCHIE_LOCAL_MODEL_ENDPOINT","http://127.0.0.1:8080/v1/chat/completions"));ap.add_argument("--model",default=os.environ.get("ARCHIE_LOCAL_MODEL","local-model"));ap.add_argument("--study-db",default=os.environ.get("ARCHIE_STUDY_DB",""));ns=ap.parse_args();serve(ns.host,ns.port,ns.workspace,RuntimeConfig(endpoint=ns.endpoint,model=ns.model,study_db=ns.study_db));return 0
if __name__=="__main__":raise SystemExit(main())
