from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from core import canonical, receipt
from corpus_foundry import Record, build_manifest, contamination_filter, ingest_tree

HERE = Path(__file__).resolve().parent
VENDOR_SKIP = {"node_modules", ".git", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__"}


def load_plan(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != "archie-corpus-sources/v1":
        raise ValueError("unexpected source plan schema")
    return value


def declared_license_allowed(value: str, allowed: set[str], *, study_only: bool) -> bool:
    if study_only:
        return True
    parts = {x.strip() for x in value.replace("(", "").replace(")", "").replace(" OR ", "|").split("|")}
    return bool(parts) and parts <= allowed


def clone_repo(repo: str, dst: Path, *, depth: int = 1) -> dict[str, Any]:
    git = shutil.which("git")
    if not git:
        return {"ok": False, "reason": "git-missing"}
    dst.parent.mkdir(parents=True, exist_ok=True)
    if (dst / ".git").is_dir():
        p = subprocess.run([git, "-C", str(dst), "fetch", "--depth", str(depth), "origin"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        if p.returncode == 0:
            subprocess.run([git, "-C", str(dst), "reset", "--hard", "FETCH_HEAD"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        return {"ok": p.returncode == 0, "stdout": p.stdout[-3000:], "existing": True}
    url = f"https://github.com/{repo}.git"
    p = subprocess.run([git, "clone", "--depth", str(depth), "--filter=blob:limit=2m", url, str(dst)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    return {"ok": p.returncode == 0, "stdout": p.stdout[-3000:], "existing": False}


def clean_walk_tree(root: Path) -> Path:
    # ingest_tree already restricts extensions; this helper removes only obvious
    # generated/vendor directories from a disposable corpus cache, never source repos elsewhere.
    for p in sorted(root.rglob("*"), reverse=True):
        if p.is_dir() and p.name in VENDOR_SKIP and p != root / ".git":
            shutil.rmtree(p, ignore_errors=True)
    return root


def write_shards(records: list[Record], blobs: dict[str, bytes], out: Path, *, max_bytes: int = 128 * 1024 * 1024) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    shards = []
    for split in ("train", "validation", "heldout"):
        group = [r for r in records if r.split == split and not r.contamination]
        part = 0; current = 0; fh = None; path = None; count = 0
        def open_next():
            nonlocal part, current, fh, path, count
            if fh: fh.close()
            path = out / f"{split}-{part:05d}.jsonl"
            fh = path.open("wb"); current = 0; count = 0; part += 1
        if group: open_next()
        for r in group:
            row = canonical({"id": r.id, "source": r.source, "license": r.license, "kind": r.kind, "text": blobs[r.sha256].decode("utf-8", "replace")}) + b"\n"
            if current and current + len(row) > max_bytes:
                shards.append({"path": path.name, "split": split, "bytes": current, "records": count})
                open_next()
            fh.write(row); current += len(row); count += 1
        if fh:
            fh.close(); shards.append({"path": path.name, "split": split, "bytes": current, "records": count})
    for s in shards:
        p = out / s["path"]
        s["sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"shards": shards, "bytes": sum(s["bytes"] for s in shards), "records": sum(s["records"] for s in shards)}


def build(plan_path: Path, cache: Path, out: Path, *, allow_network: bool = False, heldout_hashes: set[str] | None = None) -> dict[str, Any]:
    plan = load_plan(plan_path)
    allowed = set(plan["policy"].get("allowed_spdx") or [])
    records: list[Record] = []
    blobs: dict[str, bytes] = {}
    source_results = []
    for src in plan.get("sources") or []:
        repo = str(src["repo"]); lic = str(src["license"]); study_only = bool(src.get("study_only"))
        if not declared_license_allowed(lic, allowed, study_only=study_only):
            source_results.append({"repo": repo, "status": "REFUSED_LICENSE", "license": lic}); continue
        dst = cache / repo.replace("/", "__")
        if not dst.exists():
            if not allow_network:
                source_results.append({"repo": repo, "status": "MISSING_CACHE"}); continue
            cr = clone_repo(repo, dst)
            if not cr["ok"]:
                source_results.append({"repo": repo, "status": "CLONE_FAILED", "detail": cr}); continue
        root = clean_walk_tree(dst)
        rs, bs = ingest_tree(root, source_prefix=f"github:{repo}", license=lic)
        if study_only:
            rs = [Record(r.id,r.source,r.license,r.split,r.kind,r.sha256,r.bytes,tuple(sorted(set(r.contamination+("study-only",)))),{**(r.metadata or {}),"domain":src.get("domain")}) for r in rs]
        else:
            rs = [Record(r.id,r.source,r.license,r.split,r.kind,r.sha256,r.bytes,r.contamination,{**(r.metadata or {}),"domain":src.get("domain")}) for r in rs]
        added = 0
        for r in rs:
            if r.sha256 in blobs: continue
            records.append(r); blobs[r.sha256] = bs[r.sha256]; added += 1
        source_results.append({"repo": repo, "status": "INGESTED", "records": added})
    records = contamination_filter(records, heldout_hashes or set())
    manifest = build_manifest(records)
    shards = write_shards(records, blobs, out / "shards")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    result = {"sources": source_results, "manifest": {k:v for k,v in manifest.items() if k != "records"}, "shards": shards}
    (out / "build-receipt.json").write_text(json.dumps(receipt("corpus.build", result), indent=2), encoding="utf-8")
    return result


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--plan",type=Path,default=HERE/"corpus_sources.json")
    ap.add_argument("--cache",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    ap.add_argument("--allow-network",action="store_true")
    ns=ap.parse_args(); print(json.dumps(build(ns.plan,ns.cache,ns.out,allow_network=ns.allow_network),indent=2)); return 0

if __name__=="__main__": raise SystemExit(main())
