from __future__ import annotations

import json
import pathlib
import shutil
import sqlite3
import subprocess
import tarfile
from typing import Any, Mapping

from .common import PROMOTION, ContinuumError, read_json, run_checked, sha256_file, utc_now


class StateDB:
    def __init__(self, path:pathlib.Path):
        path.parent.mkdir(parents=True,exist_ok=True); self.connection=sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE IF NOT EXISTS runs(run_id INTEGER PRIMARY KEY,status TEXT NOT NULL,capsule_digest TEXT,updated_at TEXT NOT NULL)")
        self.connection.execute("CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY,status TEXT NOT NULL,source_sha TEXT NOT NULL,receipt_path TEXT,updated_at TEXT NOT NULL)")
        self.connection.commit()
    def run_seen(self,run_id:int)->bool: return self.connection.execute("SELECT 1 FROM runs WHERE run_id=?",(run_id,)).fetchone() is not None
    def record_run(self,run_id:int,status:str,digest:str|None=None)->None:
        self.connection.execute("INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,capsule_digest=excluded.capsule_digest,updated_at=excluded.updated_at",(run_id,status,digest,utc_now())); self.connection.commit()
    def record_job(self,job_id:str,status:str,source_sha:str,receipt_path:str|None=None)->None:
        self.connection.execute("INSERT INTO jobs VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,source_sha=excluded.source_sha,receipt_path=excluded.receipt_path,updated_at=excluded.updated_at",(job_id,status,source_sha,receipt_path,utc_now())); self.connection.commit()


def latest_capsule_runs(config:Mapping[str,Any])->list[dict[str,Any]]:
    poll=config["poll"]
    result=run_checked(["gh","run","list","--repo",config["repo"],"--workflow",poll["workflow"],"--branch",poll["branch"],"--status","success","--limit",str(poll.get("limit",20)),"--json","databaseId,headSha,createdAt,event"])
    data=json.loads(result.stdout)
    if not isinstance(data,list): raise ContinuumError("unexpected gh run list JSON")
    return sorted(data,key=lambda x:x["databaseId"])


def pull_capsule_run(run_id:int,config:Mapping[str,Any],workspace:pathlib.Path)->pathlib.Path:
    destination=workspace/"incoming"/str(run_id)
    if destination.exists(): shutil.rmtree(destination)
    destination.mkdir(parents=True)
    run_checked(["gh","run","download",str(run_id),"--repo",config["repo"],"--dir",str(destination)])
    capsules=list(destination.rglob("capsule.json"))
    if len(capsules)!=1: raise ContinuumError(f"run {run_id} must contain exactly one capsule.json")
    return capsules[0]


def create_sha256sums(job_dir:pathlib.Path)->pathlib.Path:
    lines=[]
    for path in sorted(p for p in job_dir.rglob("*") if p.is_file() and p.name!="SHA256SUMS"):
        lines.append(f"{sha256_file(path)}  {path.relative_to(job_dir).as_posix()}")
    output=job_dir/"SHA256SUMS"; output.write_text("\n".join(lines)+"\n",encoding="utf-8"); return output


def publish_job(job_dir:pathlib.Path,config:Mapping[str,Any])->pathlib.Path:
    receipt=read_json(job_dir/"receipt.json")
    if receipt.get("status")!="success" or receipt.get("promotion")!=PROMOTION: raise ContinuumError("only successful research-only jobs may publish")
    create_sha256sums(job_dir); bundle=job_dir/f"{receipt['job_id']}.tar.gz"
    with tarfile.open(bundle,"w:gz") as archive:
        for path in sorted(p for p in job_dir.rglob("*") if p.is_file() and p!=bundle): archive.add(path,arcname=path.relative_to(job_dir))
    publish=config.get("publish",{}); mode=publish.get("mode","none")
    if mode=="none": return bundle
    if mode!="release": raise ContinuumError(f"unsupported publish mode: {mode}")
    repo=config["repo"]; tag=f"{publish.get('tag_prefix','archie-compute')}/{receipt['job_id']}"
    notes=job_dir/"release-notes.md"; notes.write_text(f"Research-only local compute result.\n\n- Source: `{receipt['source_sha']}`\n- Capsule: `{receipt['capsule_digest']}`\n- Inventory: `{receipt['inventory_digest']}`\n- Promotion: `{PROMOTION}`\n",encoding="utf-8")
    if subprocess.run(["gh","release","view",tag,"--repo",repo],text=True,capture_output=True).returncode!=0:
        argv=["gh","release","create",tag,"--repo",repo,"--target",receipt["source_sha"],"--title",f"Archie compute {receipt['job_id']}","--notes-file",str(notes)]
        if publish.get("draft",True): argv.append("--draft")
        run_checked(argv)
    run_checked(["gh","release","upload",tag,str(bundle),str(job_dir/"receipt.json"),str(job_dir/"SHA256SUMS"),"--repo",repo,"--clobber"])
    return bundle
