from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import corpus_foundry
import court
import model_sourcing
import voxel_game
import voxel_heldout
from local_model_maker import RuntimeConfig, probe


def dump(v) -> None:
    print(json.dumps(v, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="archie-maker", description="One front door for the full local maker stack")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("court")

    vr = sub.add_parser("voxel-reference")
    vr.add_argument("out", type=Path)
    vr.add_argument("--seed", type=int, default=1337)
    vr.add_argument("--brief", default="procedural survival voxel sandbox")

    cp = sub.add_parser("corpus-tree")
    cp.add_argument("root", type=Path)
    cp.add_argument("--source-prefix", required=True)
    cp.add_argument("--license", required=True)
    cp.add_argument("--manifest", type=Path, required=True)

    mp = sub.add_parser("model-plan")
    mp.add_argument("--vram-gib", type=float, required=True)
    mp.add_argument("--disk-gib", type=float, required=True)

    pp = sub.add_parser("probe-local")
    pp.add_argument("--endpoint", default=os.environ.get("ARCHIE_LOCAL_MODEL_ENDPOINT", "http://127.0.0.1:8080/v1/chat/completions"))
    pp.add_argument("--model", default=os.environ.get("ARCHIE_LOCAL_MODEL", "local-model"))

    ev = sub.add_parser("voxel-eval")
    ev.add_argument("out", type=Path)
    ev.add_argument("--endpoint", default=os.environ.get("ARCHIE_LOCAL_MODEL_ENDPOINT", "http://127.0.0.1:8080/v1/chat/completions"))
    ev.add_argument("--model", default=os.environ.get("ARCHIE_LOCAL_MODEL", "local-model"))
    ev.add_argument("--count", type=int, default=3)

    ns = ap.parse_args(argv)
    if ns.cmd == "court":
        r = court.run(); dump(r); return 0 if r["payload"]["all_required_pass"] else 1
    if ns.cmd == "voxel-reference":
        r = voxel_game.generate(ns.out, seed=ns.seed, brief=ns.brief); dump(r); return 0
    if ns.cmd == "corpus-tree":
        records, _ = corpus_foundry.ingest_tree(ns.root, source_prefix=ns.source_prefix, license=ns.license)
        manifest = corpus_foundry.build_manifest(records)
        ns.manifest.parent.mkdir(parents=True, exist_ok=True)
        ns.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        dump({"records": len(records), "bytes": manifest["bytes"], "manifest": str(ns.manifest), "sha256": manifest["sha256"]})
        return 0
    if ns.cmd == "model-plan":
        dump(model_sourcing.plan(vram_gib=ns.vram_gib, disk_gib=ns.disk_gib)); return 0
    cfg = RuntimeConfig(endpoint=ns.endpoint, model=ns.model)
    if ns.cmd == "probe-local":
        r = probe(cfg); dump(r); return 0 if r["payload"]["status"] == "READY" else 2
    if ns.cmd == "voxel-eval":
        r = voxel_heldout.evaluate_suite(cfg, ns.out, count=ns.count); dump(r); return 0 if r["payload"].get("passes") else 3
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
