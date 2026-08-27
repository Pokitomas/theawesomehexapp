from __future__ import annotations

import argparse
import hashlib
import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import canonical, receipt

SCHEMA="archie-maker-curriculum/v1"
DOMAINS=("voxel-game","canvas-game","video-editor","local-tool","fullstack-dashboard","compiler-tool","file-format","benchmark-harness","offline-pwa","desktop-utility")
FEATURES={
"voxel-game":("procedural terrain","first-person controls","collision","inventory","save/load","block interaction","day/night","entities","crafting","performance HUD"),
"canvas-game":("input","physics","levels","particles","audio toggle","save state","score","pause","responsive canvas","replay"),
"video-editor":("timeline","trim","split","undo/redo","project JSON","audio gain","render plan","frame stepping","markers","proxy media"),
"local-tool":("CLI","structured receipts","dry-run","idempotence","workspace boundary","config file","logging","tests","benchmark","resume"),
"fullstack-dashboard":("REST API","local database","forms","filtering","sorting","export","validation","tests","responsive UI","audit log"),
"compiler-tool":("lexer","parser","AST","diagnostics","formatter","tests","CLI","source maps","incremental cache","benchmark"),
"file-format":("schema","parser","serializer","roundtrip","versioning","validation","migration","fuzz cases","CLI","docs"),
"benchmark-harness":("deterministic seeds","warmup","latency","throughput","memory","JSON output","baseline","regression gate","repeatability","report"),
"offline-pwa":("offline shell","local persistence","import/export","responsive UI","keyboard shortcuts","validation","tests","install metadata","no CDN","recovery"),
"desktop-utility":("file picker","settings","history","search","keyboard shortcuts","export","error recovery","tests","portable state","benchmark"),
}
LANGS=("HTML/CSS/JavaScript","Python","TypeScript","Rust","C++")

@dataclass(frozen=True)
class Task:
    id:str; split:str; seed:int; domain:str; language:str; brief:str; required:tuple[str,...]

def _split(seed:int)->str:
    x=int(hashlib.sha256(f"curriculum:{seed}".encode()).hexdigest()[:8],16)%1000
    return "train" if x<900 else ("validation" if x<950 else "heldout")

def make(seed:int)->Task:
    r=random.Random(seed); domain=r.choice(DOMAINS); feats=list(FEATURES[domain]); r.shuffle(feats); required=tuple(sorted(feats[:r.randint(5,8)])); lang=r.choice(LANGS)
    quality=r.choice(("single-command runnable","offline-first","dependency-light","portable","deterministic"))
    brief=f"Create a {quality} {domain.replace('-',' ')} in {lang}. Required: {', '.join(required)}. Inspect your work, run relevant tests/checks, repair failures, and finish only after the project is runnable."
    split=_split(seed); tid=hashlib.sha256((split+"\0"+brief+"\0"+str(seed)).encode()).hexdigest()[:20]
    return Task(tid,split,seed,domain,lang,brief,required)

def generate(count:int=100_000,base_seed:int=1_000_000)->dict[str,Any]:
    tasks=[make(base_seed+i*104729) for i in range(max(1,int(count)))]
    ids={t.id for t in tasks}; counts={s:sum(t.split==s for t in tasks) for s in ("train","validation","heldout")}
    body={"schema":SCHEMA,"count":len(tasks),"counts":counts,"tasks":[asdict(t) for t in tasks],"unique":len(ids)==len(tasks)}
    body["sha256"]=hashlib.sha256(canonical(body)).hexdigest(); return body

def write_shards(data:dict[str,Any],out:Path,per_shard:int=5000)->dict[str,Any]:
    out.mkdir(parents=True,exist_ok=True); shards=[]
    for split in ("train","validation","heldout"):
        rows=[x for x in data["tasks"] if x["split"]==split]
        for i in range(0,len(rows),per_shard):
            part=rows[i:i+per_shard]; path=out/f"{split}-{i//per_shard:05d}.jsonl"
            with path.open("w",encoding="utf-8",newline="\n") as f:
                for row in part: f.write(json.dumps(row,separators=(",",":"),ensure_ascii=False)+"\n")
            shards.append({"path":path.name,"split":split,"records":len(part),"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    return receipt("curriculum.shards",{"shards":shards,"records":sum(x["records"] for x in shards),"bytes":sum(x["bytes"] for x in shards),"source_sha256":data["sha256"]})

def court()->dict[str,Any]:
    a=generate(1000,123); b=generate(1000,123); held={x["id"] for x in a["tasks"] if x["split"]=="heldout"}; train={x["id"] for x in a["tasks"] if x["split"]=="train"}
    return receipt("curriculum.court",{"passes":a==b and a["unique"] and not held&train and a["counts"]["heldout"]>0,"deterministic":a==b,"counts":a["counts"],"sha256":a["sha256"]})

def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("--count",type=int,default=100000); ap.add_argument("--out",type=Path,required=True); ap.add_argument("--seed",type=int,default=1000000); ns=ap.parse_args(); data=generate(ns.count,ns.seed); r=write_shards(data,ns.out); print(json.dumps(r,indent=2)); return 0
if __name__=="__main__": raise SystemExit(main())
