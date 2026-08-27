from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import corpus_build
import corpus_foundry
import court
import curriculum
import local_runtime
import maker_server
import model_sourcing
import model_tournament
import study_index
import train_sft
import trajectory_dataset
import voxel_game
import voxel_heldout
from local_model_maker import RuntimeConfig, probe


def dump(v) -> None:
    print(json.dumps(v, indent=2, default=str))


def add_runtime_args(p) -> None:
    p.add_argument("--endpoint", default=os.environ.get("ARCHIE_LOCAL_MODEL_ENDPOINT", "http://127.0.0.1:8080/v1/chat/completions"))
    p.add_argument("--model", default=os.environ.get("ARCHIE_LOCAL_MODEL", "local-model"))
    p.add_argument("--study-db", default=os.environ.get("ARCHIE_STUDY_DB", ""))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="archie-maker", description="One front door for the complete local maker stack")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("court")

    vr = sub.add_parser("voxel-reference"); vr.add_argument("out", type=Path); vr.add_argument("--seed", type=int, default=1337); vr.add_argument("--brief", default="procedural survival voxel sandbox")
    ev = sub.add_parser("voxel-eval"); ev.add_argument("out", type=Path); ev.add_argument("--count", type=int, default=3); add_runtime_args(ev)
    pp = sub.add_parser("probe-local"); add_runtime_args(pp)

    cp = sub.add_parser("corpus-tree"); cp.add_argument("root", type=Path); cp.add_argument("--source-prefix", required=True); cp.add_argument("--license", required=True); cp.add_argument("--manifest", type=Path, required=True)
    cb = sub.add_parser("corpus-build"); cb.add_argument("--plan", type=Path, default=HERE/"corpus_sources.json"); cb.add_argument("--cache", type=Path, required=True); cb.add_argument("--out", type=Path, required=True); cb.add_argument("--allow-network", action="store_true")
    cu = sub.add_parser("curriculum"); cu.add_argument("--count", type=int, default=100000); cu.add_argument("--out", type=Path, required=True); cu.add_argument("--seed", type=int, default=1000000)

    si = sub.add_parser("study-build"); si.add_argument("--db", type=Path, required=True); si.add_argument("shards", nargs="+", type=Path)
    ss = sub.add_parser("study-search"); ss.add_argument("--db", type=Path, required=True); ss.add_argument("query"); ss.add_argument("--limit", type=int, default=8)

    mp = sub.add_parser("model-plan"); mp.add_argument("--vram-gib", type=float, required=True); mp.add_argument("--disk-gib", type=float, required=True)
    rd = sub.add_parser("runtime-discover"); rd.add_argument("roots", nargs="*", type=Path)
    rl = sub.add_parser("runtime-launch"); rl.add_argument("--exe", required=True); rl.add_argument("--model-path", required=True); rl.add_argument("--port", type=int, default=8080); rl.add_argument("--ctx", type=int, default=8192); rl.add_argument("--ngl", type=int, default=999); rl.add_argument("--threads", type=int, default=0); rl.add_argument("--log", type=Path, required=True)

    sv = sub.add_parser("serve"); sv.add_argument("--host", default="127.0.0.1"); sv.add_argument("--port", type=int, default=8844); sv.add_argument("--workspace", type=Path, default=Path.home()/"archie-maker-projects"); add_runtime_args(sv)
    mt = sub.add_parser("tournament"); mt.add_argument("--models", type=Path, required=True); mt.add_argument("--out", type=Path, required=True); mt.add_argument("--cases", type=int, default=3)
    td = sub.add_parser("trajectory-dataset"); td.add_argument("inputs", nargs="+", type=Path); td.add_argument("--out", type=Path, required=True)
    sf = sub.add_parser("sft"); sf.add_argument("--base-model", default="Qwen/Qwen3-4B"); sf.add_argument("--train", type=Path, required=True); sf.add_argument("--out", type=Path, required=True); sf.add_argument("--max-seq", type=int, default=1024); sf.add_argument("--epochs", type=float, default=1.0); sf.add_argument("--execute", action="store_true")

    ns = ap.parse_args(argv)
    if ns.cmd == "court":
        r=court.run(); dump(r); return 0 if r["payload"]["all_required_pass"] else 1
    if ns.cmd == "voxel-reference": dump(voxel_game.generate(ns.out, seed=ns.seed, brief=ns.brief)); return 0
    if ns.cmd == "corpus-tree":
        records,_=corpus_foundry.ingest_tree(ns.root,source_prefix=ns.source_prefix,license=ns.license); manifest=corpus_foundry.build_manifest(records); ns.manifest.parent.mkdir(parents=True,exist_ok=True); ns.manifest.write_text(json.dumps(manifest,indent=2),encoding="utf-8"); dump({"records":len(records),"bytes":manifest["bytes"],"manifest":str(ns.manifest),"sha256":manifest["sha256"]}); return 0
    if ns.cmd == "corpus-build": dump(corpus_build.build(ns.plan,ns.cache,ns.out,allow_network=ns.allow_network)); return 0
    if ns.cmd == "curriculum": data=curriculum.generate(ns.count,ns.seed); dump(curriculum.write_shards(data,ns.out)); return 0
    if ns.cmd == "study-build": dump(study_index.ingest_jsonl(ns.db,ns.shards)); return 0
    if ns.cmd == "study-search": dump(study_index.search(ns.db,ns.query,limit=ns.limit)); return 0
    if ns.cmd == "model-plan": dump(model_sourcing.plan(vram_gib=ns.vram_gib,disk_gib=ns.disk_gib)); return 0
    if ns.cmd == "runtime-discover": dump(local_runtime.discover(ns.roots)); return 0
    if ns.cmd == "runtime-launch": dump(local_runtime.launch(local_runtime.RuntimeLaunch("llama.cpp",ns.exe,ns.model_path,port=ns.port,ctx=ns.ctx,gpu_layers=ns.ngl,threads=ns.threads),ns.log)); return 0
    if ns.cmd == "serve": maker_server.serve(ns.host,ns.port,ns.workspace,RuntimeConfig(endpoint=ns.endpoint,model=ns.model,study_db=ns.study_db)); return 0
    if ns.cmd == "tournament": dump(model_tournament.run(model_tournament.load_entries(ns.models),ns.out,cases=ns.cases)); return 0
    if ns.cmd == "trajectory-dataset": ds=trajectory_dataset.compile_sft(trajectory_dataset.read_json_objects(ns.inputs)); dump(trajectory_dataset.write_jsonl(ds,ns.out)); return 0
    if ns.cmd == "sft":
        recipe=train_sft.Recipe(ns.base_model,str(ns.train),str(ns.out),max_seq_length=ns.max_seq,epochs=ns.epochs); r=train_sft.train(recipe) if ns.execute else train_sft.recipe_receipt(recipe); dump(r); return 0 if r["payload"].get("status") in {None,"COMPLETE"} and r["payload"].get("admissible",True) else 2
    cfg=RuntimeConfig(endpoint=ns.endpoint,model=ns.model,study_db=ns.study_db)
    if ns.cmd == "probe-local": r=probe(cfg); dump(r); return 0 if r["payload"]["status"]=="READY" else 2
    if ns.cmd == "voxel-eval": r=voxel_heldout.evaluate_suite(cfg,ns.out,count=ns.count); dump(r); return 0 if r["payload"].get("passes") else 3
    return 1

if __name__ == "__main__": raise SystemExit(main())
