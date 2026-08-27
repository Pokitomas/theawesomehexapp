from __future__ import annotations

import argparse
import hashlib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import canonical, receipt
from local_model_maker import RuntimeConfig, probe
from voxel_heldout import evaluate_suite

SCHEMA="archie-model-tournament/v1"

@dataclass(frozen=True)
class Entry:
    name:str
    endpoint:str
    model:str


def load_entries(path:Path)->list[Entry]:
    value=json.loads(path.read_text(encoding="utf-8")); rows=value.get("models") if isinstance(value,dict) else value
    return [Entry(str(x["name"]),str(x["endpoint"]),str(x.get("model") or x["name"])) for x in rows if isinstance(x,dict)]


def run(entries:list[Entry],out:Path,*,cases:int=3)->dict[str,Any]:
    results=[]; out.mkdir(parents=True,exist_ok=True)
    for entry in entries:
        cfg=RuntimeConfig(endpoint=entry.endpoint,model=entry.model)
        p=probe(cfg)
        if p["payload"]["status"]!="READY":
            results.append({"entry":asdict(entry),"status":"BLOCKED","probe":p["payload"],"score":-1.0}); continue
        t0=time.perf_counter(); suite=evaluate_suite(cfg,out/entry.name,cases); elapsed=time.perf_counter()-t0
        sp=suite["payload"]; success=float(sp.get("success_rate") or 0.0)
        # Correct held-out completion dominates speed. Speed only breaks close ties.
        score=success*1000.0 - min(100.0,elapsed/60.0)
        results.append({"entry":asdict(entry),"status":sp.get("status"),"suite":sp,"elapsed_s":elapsed,"score":score})
    ranked=sorted(results,key=lambda x:(-float(x["score"]),x["entry"]["name"]))
    body={"schema":SCHEMA,"cases_per_model":cases,"ranked":ranked,"winner":ranked[0]["entry"]["name"] if ranked and ranked[0]["score"]>=0 else None}
    body["sha256"]=hashlib.sha256(canonical(body)).hexdigest(); return receipt("model_tournament.run",body)


def court()->dict[str,Any]:
    rows=[{"entry":{"name":"a"},"score":2},{"entry":{"name":"b"},"score":3}]; ranked=sorted(rows,key=lambda x:(-x["score"],x["entry"]["name"])); return receipt("model_tournament.court",{"passes":ranked[0]["entry"]["name"]=="b","selection":"heldout-first"})


def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("--models",type=Path,required=True); ap.add_argument("--out",type=Path,required=True); ap.add_argument("--cases",type=int,default=3); ns=ap.parse_args(); r=run(load_entries(ns.models),ns.out,cases=ns.cases); print(json.dumps(r,indent=2)); return 0
if __name__=="__main__": raise SystemExit(main())
