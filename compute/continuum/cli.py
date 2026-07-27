from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import shutil
import sys
import time
from typing import Any, Mapping, Sequence

from .capsule import Capsule, sign_capsule, verify_capsule
from .common import PROMOTION, PROTOCOL, ContinuumError, expand_path, read_json, run_checked, write_json
from .execution import cuda_preflight, execute_capsule
from .github_io import StateDB, latest_capsule_runs, publish_job, pull_capsule_run
from .handoff import SuccessBarrier


def load_config(path:pathlib.Path)->dict[str,Any]:
    config=read_json(path)
    if not isinstance(config,dict): raise ContinuumError("config must be an object")
    for field in ("node_id","repo","workspace","security","tasks"):
        if field not in config: raise ContinuumError(f"config missing {field}")
    return config


def hmac_key(config:Mapping[str,Any])->str:
    env=str(config.get("security",{}).get("hmac_env","ARCHIE_CONTINUUM_HMAC_KEY")); value=os.getenv(env)
    if not value or len(value)<32: raise ContinuumError(f"{env} must contain at least 32 characters")
    return value


def doctor(config:Mapping[str,Any])->dict[str,Any]:
    for executable in ("git","gh"):
        if not shutil.which(executable): raise ContinuumError(f"missing {executable}")
    auth=run_checked(["gh","auth","status"])
    return {"git":shutil.which("git"),"gh":shutil.which("gh"),"gh_auth":auth.stderr.strip() or "ok","hmac_key":"present" if hmac_key(config) else "missing","runtime":cuda_preflight(bool(config.get("security",{}).get("require_cuda",False)))}


def create_capsule(args:argparse.Namespace)->None:
    issued=dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    raw={"protocol":PROTOCOL,"job_id":args.job_id,"issued_at":issued.isoformat().replace("+00:00","Z"),"expires_at":(issued+dt.timedelta(hours=args.ttl_hours)).isoformat().replace("+00:00","Z"),"source":{"repo":args.repo,"sha":args.source_sha},"task":{"name":args.task,"args":json.loads(args.task_args)},"nodes":json.loads(args.nodes),"shards":args.shards,"promotion":PROMOTION}
    key=os.getenv(args.key_env)
    if not key or len(key)<32: raise ContinuumError(f"{args.key_env} must contain at least 32 characters")
    signed=sign_capsule(raw,key,args.key_id); write_json(pathlib.Path(args.output),signed); print(json.dumps({"capsule":args.output,"digest":Capsule(signed).digest}))


def serve(args:argparse.Namespace)->None:
    config=load_config(pathlib.Path(args.config)); workspace=expand_path(str(config["workspace"])); db=StateDB(workspace/"state.sqlite3"); key=hmac_key(config)
    while True:
        try:
            for item in latest_capsule_runs(config):
                run_id=int(item["databaseId"])
                if db.run_seen(run_id): continue
                db.record_run(run_id,"downloading")
                try:
                    path=pull_capsule_run(run_id,config,workspace); capsule=verify_capsule(read_json(path),key,config)
                    if item.get("headSha")!=capsule.source_sha: raise ContinuumError("capsule source differs from control run head")
                    db.record_run(run_id,"executing",capsule.digest); receipt=execute_capsule(capsule,config)
                    if config.get("publish",{}).get("mode","none")!="none": publish_job(receipt.parent,config)
                    db.record_run(run_id,"complete",capsule.digest)
                except Exception as exc:
                    db.record_run(run_id,f"failed:{exc}"); print(f"run {run_id} failed: {exc}",file=sys.stderr)
            if args.once:return
        except Exception as exc:
            print(f"poll failed: {exc}",file=sys.stderr)
            if args.once:raise
        time.sleep(max(15,args.interval))


def build_parser()->argparse.ArgumentParser:
    p=argparse.ArgumentParser(description="Signed local compute and provider-neutral SUCCESS handoff")
    sub=p.add_subparsers(dest="command",required=True)
    c=sub.add_parser("capsule-create"); c.add_argument("--repo",required=True); c.add_argument("--source-sha",required=True); c.add_argument("--job-id",required=True); c.add_argument("--task",required=True); c.add_argument("--task-args",default="{}"); c.add_argument("--nodes",default='["alienware-1"]'); c.add_argument("--shards",type=int,default=1); c.add_argument("--ttl-hours",type=int,default=24); c.add_argument("--key-env",default="ARCHIE_CONTINUUM_HMAC_KEY"); c.add_argument("--key-id",default="continuum-v1"); c.add_argument("--output",default="capsule.json"); c.set_defaults(func=create_capsule)
    v=sub.add_parser("verify"); v.add_argument("--config",required=True); v.add_argument("--capsule",required=True); v.set_defaults(func=lambda a: print(json.dumps({"digest":verify_capsule(read_json(pathlib.Path(a.capsule)),hmac_key(load_config(pathlib.Path(a.config))),load_config(pathlib.Path(a.config))).digest},indent=2)))
    e=sub.add_parser("execute"); e.add_argument("--config",required=True); e.add_argument("--capsule",required=True); e.set_defaults(func=lambda a: print(execute_capsule(verify_capsule(read_json(pathlib.Path(a.capsule)),hmac_key(load_config(pathlib.Path(a.config))),load_config(pathlib.Path(a.config))),load_config(pathlib.Path(a.config)))))
    s=sub.add_parser("SUCCESS",aliases=["success"]); s.add_argument("--config",required=True); s.add_argument("--state",required=True); s.add_argument("--source-sha",required=True); s.set_defaults(func=lambda a: print(json.dumps(SuccessBarrier(load_config(pathlib.Path(a.config)),expand_path(load_config(pathlib.Path(a.config))["workspace"])/"manual-handoffs"/f"success-{int(time.time())}").emit(read_json(pathlib.Path(a.state)),a.source_sha,"SUCCESS"),indent=2)))
    d=sub.add_parser("doctor"); d.add_argument("--config",required=True); d.set_defaults(func=lambda a: print(json.dumps(doctor(load_config(pathlib.Path(a.config))),indent=2)))
    pull=sub.add_parser("pull"); pull.add_argument("--config",required=True); pull.add_argument("--run-id",type=int,required=True); pull.set_defaults(func=lambda a: print(pull_capsule_run(a.run_id,load_config(pathlib.Path(a.config)),expand_path(load_config(pathlib.Path(a.config))["workspace"]))))
    pub=sub.add_parser("publish"); pub.add_argument("--config",required=True); pub.add_argument("--job-dir",required=True); pub.set_defaults(func=lambda a: print(publish_job(expand_path(a.job_dir),load_config(pathlib.Path(a.config)))))
    daemon=sub.add_parser("serve"); daemon.add_argument("--config",required=True); daemon.add_argument("--interval",type=int,default=60); daemon.add_argument("--once",action="store_true"); daemon.set_defaults(func=serve)
    return p


def main(argv:Sequence[str]|None=None)->int:
    try: args=build_parser().parse_args(argv); args.func(args); return 0
    except ContinuumError as exc: print(f"continuum: {exc}",file=sys.stderr); return 2
