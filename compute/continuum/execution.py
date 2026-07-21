from __future__ import annotations

import json
import os
import pathlib
import platform
import socket
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence

from .capsule import Capsule, assigned_shards, validate_task_args
from .common import PROMOTION, ContinuumError, canonical_json, expand_path, run_checked, sha256_bytes, sha256_file, utc_now, write_json
from .github_io import StateDB, create_sha256sums
from .handoff import StudyWatcher, SuccessBarrier, collect_files


def ensure_checkout(config:Mapping[str,Any],capsule:Capsule,workspace:pathlib.Path)->pathlib.Path:
    cache=expand_path(str(config.get("repo_cache",workspace/"repo-cache")))
    if not (cache/".git").exists():
        cache.parent.mkdir(parents=True,exist_ok=True); run_checked(["git","clone","--filter=blob:none",f"https://github.com/{capsule.repo}.git",str(cache)])
    run_checked(["git","-C",str(cache),"fetch","--no-tags","origin",capsule.source_sha])
    worktree=workspace/"worktrees"/capsule.source_sha
    if not worktree.exists():
        worktree.parent.mkdir(parents=True,exist_ok=True); run_checked(["git","-C",str(cache),"worktree","add","--detach",str(worktree),capsule.source_sha])
    actual=run_checked(["git","-C",str(worktree),"rev-parse","HEAD"]).stdout.strip()
    if actual!=capsule.source_sha: raise ContinuumError("exact worktree SHA mismatch")
    if run_checked(["git","-C",str(worktree),"status","--porcelain"]).stdout.strip(): raise ContinuumError("exact worktree is dirty")
    return worktree


def cuda_preflight(required:bool)->dict[str,Any]:
    runtime={"hostname":socket.gethostname(),"platform":platform.platform(),"python":sys.version,"cuda_required":required}
    if not required: return runtime
    smi=run_checked(["nvidia-smi","--query-gpu=name,uuid,memory.total,driver_version","--format=csv,noheader"])
    probe=run_checked([sys.executable,"-c","import json,torch; assert torch.cuda.is_available(); print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'device':torch.cuda.get_device_name(0),'count':torch.cuda.device_count()}))"])
    runtime["nvidia_smi"]=[x for x in smi.stdout.splitlines() if x.strip()]; runtime["torch"]=json.loads(probe.stdout); return runtime


def materialize_source_artifact(capsule:Capsule,args:Mapping[str,Any],job_dir:pathlib.Path)->pathlib.Path|None:
    run_id,name=args.get("source_run_id"),args.get("source_artifact")
    if run_id is None and name is None: return None
    if not isinstance(run_id,int) or not isinstance(name,str): raise ContinuumError("source_run_id and source_artifact must be paired")
    destination=job_dir/"source-artifacts"; destination.mkdir(parents=True,exist_ok=True)
    run_checked(["gh","run","download",str(run_id),"--repo",capsule.repo,"--name",name,"--dir",str(destination)])
    evidence=next(destination.rglob("evidence-bundle.json"),None)
    if evidence is None: raise ContinuumError("source artifact lacks evidence-bundle.json")
    write_json(job_dir/"source-artifact-inventory.json",{str(p.relative_to(destination)):sha256_file(p) for p in sorted(destination.rglob("*")) if p.is_file()})
    return evidence.parent


def render_argv(template:Sequence[str],values:Mapping[str,Any])->list[str]:
    try: return [token.format_map({k:str(v) for k,v in values.items()}) for token in template]
    except KeyError as exc: raise ContinuumError(f"task template missing value: {exc.args[0]}") from exc


def execute_capsule(capsule:Capsule,config:Mapping[str,Any])->pathlib.Path:
    workspace=expand_path(str(config["workspace"])); workspace.mkdir(parents=True,exist_ok=True)
    job_dir=workspace/"jobs"/capsule.job_id; job_dir.mkdir(parents=True,exist_ok=True); receipt_path=job_dir/"receipt.json"
    if receipt_path.exists() and json.loads(receipt_path.read_text()).get("status")=="success": return receipt_path
    write_json(job_dir/"capsule.json",capsule.raw); db=StateDB(workspace/"state.sqlite3"); db.record_job(capsule.job_id,"preparing",capsule.source_sha)
    worktree=ensure_checkout(config,capsule,workspace); task=config["tasks"][capsule.task_name]; args=validate_task_args(task,capsule.task_args)
    assigned=assigned_shards(capsule.job_id,capsule.raw["nodes"],capsule.raw["shards"],config["node_id"])
    if not assigned:
        write_json(receipt_path,{"job_id":capsule.job_id,"status":"not-assigned","node_id":config["node_id"],"source_sha":capsule.source_sha,"promotion":PROMOTION}); return receipt_path
    write_json(job_dir/"runtime.json",cuda_preflight(bool(task.get("require_cuda",config.get("security",{}).get("require_cuda",False)))))
    campaign_root=materialize_source_artifact(capsule,args,job_dir); output=job_dir/"output"; output.mkdir(parents=True,exist_ok=True)
    values={**args,"job_id":capsule.job_id,"node_id":config["node_id"],"source_sha":capsule.source_sha,"worktree":worktree,"job_dir":job_dir,"output_dir":output,"campaign_root":campaign_root or "","shard_indices":",".join(map(str,assigned)),"shard_count":capsule.raw["shards"]}
    argv=render_argv(task["argv"],values); cwd=(worktree/str(task.get("cwd","."))).resolve()
    if cwd!=worktree and worktree not in cwd.parents: raise ContinuumError("task cwd escapes worktree")
    env=os.environ.copy(); env.update({str(k):str(v).format_map({x:str(y) for x,y in values.items()}) for k,v in task.get("env",{}).items()})
    write_json(job_dir/"command.json",{"argv":argv,"cwd":str(cwd),"assigned_shards":assigned,"started_at":utc_now()})
    barrier=SuccessBarrier(config,job_dir); watcher=StudyWatcher(barrier,output,task.get("study_patterns",[]),capsule.source_sha,int(task.get("study_interval_seconds",30)))
    if task.get("study_patterns") and config.get("providers"): watcher.start()
    db.record_job(capsule.job_id,"running",capsule.source_sha); stdout_path,stderr_path=job_dir/"stdout.log",job_dir/"stderr.log"; started=time.monotonic(); code=-1
    try:
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr: code=subprocess.Popen(argv,cwd=cwd,env=env,text=True,stdout=stdout,stderr=stderr).wait()
    except OSError as exc: stderr_path.write_text(str(exc)+"\n")
    finally:
        watcher.stop()
        if watcher.is_alive(): watcher.join(timeout=5)
    status="success" if code==0 else "failed"; files=collect_files(output,task.get("result_patterns",["**/*"]))
    inventory={str(p.relative_to(job_dir)):sha256_file(p) for p in files+[stdout_path,stderr_path,job_dir/"capsule.json",job_dir/"runtime.json",job_dir/"command.json"] if p.exists()}
    write_json(job_dir/"inventory.json",inventory)
    receipt={"job_id":capsule.job_id,"status":status,"return_code":code,"node_id":config["node_id"],"source_repo":capsule.repo,"source_sha":capsule.source_sha,"capsule_digest":capsule.digest,"assigned_shards":assigned,"runtime_seconds":round(time.monotonic()-started,3),"inventory_digest":sha256_bytes(canonical_json(inventory)),"promotion":PROMOTION,"completed_at":utc_now()}
    write_json(receipt_path,receipt); db.record_job(capsule.job_id,status,capsule.source_sha,str(receipt_path)); create_sha256sums(job_dir)
    if status!="success": raise ContinuumError(f"task failed; evidence preserved in {job_dir}")
    state={"receipt":receipt,"inventory":inventory}
    for pattern in task.get("handoff_state_patterns",[]):
        for path in collect_files(output,[pattern]):
            try: state[str(path.relative_to(output))]=json.loads(path.read_text())
            except Exception: state[str(path.relative_to(output))]={"sha256":sha256_file(path)}
    receipt["success_barrier"]=barrier.emit(state,capsule.source_sha,"SUCCESS"); write_json(receipt_path,receipt); create_sha256sums(job_dir); return receipt_path
