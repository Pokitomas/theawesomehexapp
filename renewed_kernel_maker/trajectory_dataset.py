from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

from core import canonical, receipt

SCHEMA = "archie-maker-trajectories/v1"


def read_json_objects(paths: Iterable[Path]) -> list[dict[str, Any]]:
    out=[]
    for path in paths:
        if not path.exists(): continue
        if path.suffix == ".jsonl":
            lines=path.read_text(encoding="utf-8").splitlines()
            vals=[]
            for line in lines:
                if not line.strip(): continue
                try: vals.append(json.loads(line))
                except Exception: continue
        else:
            try:
                v=json.loads(path.read_text(encoding="utf-8")); vals=v if isinstance(v,list) else [v]
            except Exception: vals=[]
        out.extend(x for x in vals if isinstance(x,dict))
    return out


def unwrap_run(value: dict[str,Any]) -> dict[str,Any] | None:
    if value.get("kind") == "local_maker.run": return value.get("payload")
    p=value.get("payload")
    if isinstance(p,dict) and isinstance(p.get("result"),dict):
        r=p["result"]
        if r.get("kind") == "local_maker.run": return r.get("payload")
    if value.get("schema") == "archie-local-maker/v1": return value
    return None


def event_to_messages(run: dict[str,Any]) -> list[dict[str,str]]:
    # The brief text is intentionally not reconstructed from a hash. Full training
    # records must be exported by the runtime with the approved brief attached.
    approved_brief=str(run.get("approved_brief") or "")
    if not approved_brief: return []
    messages=[{"role":"system","content":"Build and verify the requested application using the maker tool protocol."},{"role":"user","content":approved_brief}]
    for ev in run.get("events") or []:
        if not isinstance(ev,dict): continue
        tool=str(ev.get("tool") or ""); args=ev.get("args") if isinstance(ev.get("args"),dict) else {}
        evidence=ev.get("evidence") if isinstance(ev.get("evidence"),dict) else {}
        if tool == "model": continue
        if tool == "finish":
            messages.append({"role":"assistant","content":json.dumps({"tool":"finish","args":args},separators=(",",":"))}); break
        messages.append({"role":"assistant","content":json.dumps({"tool":tool,"args":args},separators=(",",":"),ensure_ascii=False)})
        messages.append({"role":"user","content":"TOOL RESULT:\n"+json.dumps({"ok":bool(ev.get("ok")),"evidence":evidence},separators=(",",":"),ensure_ascii=False)[:30000]})
    return messages


def compile_sft(values:list[dict[str,Any]]) -> dict[str,Any]:
    rows=[]; skipped=0
    for value in values:
        run=unwrap_run(value)
        if not run: skipped+=1; continue
        msgs=event_to_messages(run)
        if not msgs: skipped+=1; continue
        row={"messages":msgs,"trajectory_sha256":run.get("trajectory_sha256"),"project_sha256":(run.get("project") or {}).get("sha256"),"status":run.get("status")}
        row["sha256"]=hashlib.sha256(canonical(row)).hexdigest(); rows.append(row)
    unique={r["sha256"]:r for r in rows}
    ordered=[unique[k] for k in sorted(unique)]
    return {"schema":SCHEMA,"records":ordered,"count":len(ordered),"skipped":skipped,"sha256":hashlib.sha256(canonical(ordered)).hexdigest()}


def write_jsonl(dataset:dict[str,Any],path:Path)->dict[str,Any]:
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open("w",encoding="utf-8",newline="\n") as f:
        for row in dataset["records"]: f.write(json.dumps(row,ensure_ascii=False,separators=(",",":"))+"\n")
    return receipt("trajectory_dataset.write",{"path":str(path),"records":dataset["count"],"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})


def preference_from_grades(candidates:list[dict[str,Any]])->list[dict[str,Any]]:
    by_brief={}
    for c in candidates:
        bid=((c.get("brief") or {}).get("id") if isinstance(c.get("brief"),dict) else c.get("brief_id"))
        if not bid: continue
        by_brief.setdefault(str(bid),[]).append(c)
    pairs=[]
    for bid,group in sorted(by_brief.items()):
        if len(group)<2: continue
        group=sorted(group,key=lambda x:(float((x.get("grade") or {}).get("score",0)),str((x.get("maker") or {}).get("trajectory_sha256",""))),reverse=True)
        chosen,rejected=group[0],group[-1]
        if float((chosen.get("grade") or {}).get("score",0)) <= float((rejected.get("grade") or {}).get("score",0)): continue
        pairs.append({"brief_id":bid,"chosen":(chosen.get("maker") or {}).get("trajectory_sha256"),"rejected":(rejected.get("maker") or {}).get("trajectory_sha256"),"chosen_score":(chosen.get("grade") or {}).get("score"),"rejected_score":(rejected.get("grade") or {}).get("score")})
    return pairs


def court()->dict[str,Any]:
    run={"schema":"archie-local-maker/v1","status":"FINISHED","approved_brief":"make app","trajectory_sha256":"t1","project":{"sha256":"p1"},"events":[{"tool":"write_file","args":{"path":"a"},"ok":True,"evidence":{"sha256":"x"}},{"tool":"finish","args":{"summary":"done"},"ok":True,"evidence":{}}]}
    ds1=compile_sft([run,run]); ds2=compile_sft([run,run])
    return receipt("trajectory_dataset.court",{"passes":ds1==ds2 and ds1["count"]==1,"deduped":ds1["count"]==1,"deterministic":ds1==ds2,"sha256":ds1["sha256"]})


def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("inputs",nargs="+",type=Path); ap.add_argument("--out",type=Path,required=True); ns=ap.parse_args()
    ds=compile_sft(read_json_objects(ns.inputs)); r=write_jsonl(ds,ns.out); print(json.dumps(r,indent=2)); return 0

if __name__=="__main__": raise SystemExit(main())
