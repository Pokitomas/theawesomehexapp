from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from core import canonical, receipt
from corpus_foundry import DEFAULT_EXTENSIONS, norm_text, stable_split

SCHEMA = "archie-corpus-stream/v1"
SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "coverage"}


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS docs(
      sha256 TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      source TEXT NOT NULL,
      license TEXT NOT NULL,
      kind TEXT NOT NULL,
      split TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      shard TEXT NOT NULL,
      line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_split ON docs(split);
    CREATE TABLE IF NOT EXISTS sources(repo TEXT PRIMARY KEY,status TEXT NOT NULL,license TEXT,records INTEGER DEFAULT 0,bytes INTEGER DEFAULT 0,detail TEXT);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    """)
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)", (SCHEMA,)); con.commit()
    return con


def walk_files(root: Path) -> Iterator[Path]:
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        bp = Path(base)
        for name in sorted(files):
            p = bp / name
            if p.suffix.lower() in DEFAULT_EXTENSIONS:
                yield p


class ShardWriter:
    def __init__(self, root: Path, max_bytes: int = 128 * 1024 * 1024):
        self.root = root; self.root.mkdir(parents=True, exist_ok=True); self.max_bytes = max_bytes
        self.state: dict[str, dict[str, Any]] = {}
        self.manifest: list[dict[str, Any]] = []

    def _open(self, split: str) -> dict[str, Any]:
        old = self.state.get(split)
        if old and old.get("fh"):
            self._close_one(split)
        part = 0 if old is None else int(old["part"]) + 1
        path = self.root / f"{split}-{part:05d}.jsonl"
        fh = path.open("ab", buffering=0)
        st = {"part": part, "path": path, "fh": fh, "bytes": path.stat().st_size, "records": 0, "line": 0}
        self.state[split] = st; return st

    def _close_one(self, split: str) -> None:
        st = self.state[split]; fh = st.get("fh")
        if not fh: return
        fh.close(); st["fh"] = None
        p: Path = st["path"]
        self.manifest.append({"path": p.name, "split": split, "bytes": p.stat().st_size, "records": st["records"], "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})

    def append(self, split: str, row: dict[str, Any]) -> tuple[str, int, int]:
        raw = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        st = self.state.get(split)
        if st is None or st.get("fh") is None: st = self._open(split)
        if st["bytes"] and st["bytes"] + len(raw) > self.max_bytes: st = self._open(split)
        st["fh"].write(raw); st["bytes"] += len(raw); st["records"] += 1; st["line"] += 1
        return st["path"].name, int(st["line"]), len(raw)

    def close(self) -> list[dict[str, Any]]:
        for split in list(self.state): self._close_one(split)
        return self.manifest


def clone_repo(repo: str, dst: Path, allow_network: bool) -> dict[str, Any]:
    if (dst / ".git").is_dir(): return {"ok": True, "existing": True}
    if not allow_network: return {"ok": False, "reason": "missing-cache"}
    git = shutil.which("git")
    if not git: return {"ok": False, "reason": "git-missing"}
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        p = subprocess.run([git, "clone", "--depth", "1", "--filter=blob:limit=2m", f"https://github.com/{repo}.git", str(dst)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
        return {"ok": p.returncode == 0, "returncode": p.returncode, "stdout": p.stdout[-3000:]}
    except Exception as exc: return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}


def allowed_license(value: str, allowed: set[str], study_only: bool) -> bool:
    if study_only: return True
    parts = {x.strip() for x in value.replace("(", "").replace(")", "").replace(" OR ", "|").split("|") if x.strip()}
    return bool(parts) and parts <= allowed


def ingest_repo(con: sqlite3.Connection, writer: ShardWriter, root: Path, *, repo: str, license: str, study_only: bool = False, max_file_bytes: int = 2_000_000) -> dict[str, Any]:
    records = 0; total_bytes = 0; skipped_large = 0; skipped_binary = 0; dupes = 0
    for p in walk_files(root):
        try:
            if p.stat().st_size > max_file_bytes: skipped_large += 1; continue
            text = p.read_text(encoding="utf-8")
        except Exception: skipped_binary += 1; continue
        b = norm_text(text).encode("utf-8"); h = hashlib.sha256(b).hexdigest()
        if con.execute("SELECT 1 FROM docs WHERE sha256=?", (h,)).fetchone(): dupes += 1; continue
        rel = p.relative_to(root).as_posix(); source = f"github:{repo}/{rel}"; split = "study" if study_only else stable_split(source + "\0" + h)
        row = {"id": h[:24], "source": source, "license": license, "kind": p.suffix.lower().lstrip("."), "text": b.decode("utf-8", "replace")}
        shard, line, raw_bytes = writer.append(split, row)
        con.execute("INSERT INTO docs(sha256,id,source,license,kind,split,bytes,shard,line) VALUES(?,?,?,?,?,?,?,?,?)", (h, h[:24], source, license, row["kind"], split, len(b), shard, line))
        records += 1; total_bytes += len(b)
        if records % 1000 == 0: con.commit()
    con.commit()
    return {"records": records, "bytes": total_bytes, "duplicates": dupes, "skipped_large": skipped_large, "skipped_binary": skipped_binary}


def build(plan_path: Path, cache: Path, out: Path, *, allow_network: bool = False, max_sources: int = 999, reserve_gib: float = 8.0) -> dict[str, Any]:
    plan = json.loads(plan_path.read_text(encoding="utf-8")); allowed = set(plan.get("policy", {}).get("allowed_spdx") or [])
    out.mkdir(parents=True, exist_ok=True); con = open_db(out / "corpus.db"); writer = ShardWriter(out / "shards")
    source_results = []
    try:
        for src in (plan.get("sources") or [])[:max_sources]:
            if shutil.disk_usage(out).free / (1024**3) < reserve_gib:
                source_results.append({"repo": src.get("repo"), "status": "STOP_DISK_RESERVE"}); break
            repo = str(src["repo"]); lic = str(src["license"]); study_only = bool(src.get("study_only"))
            if not allowed_license(lic, allowed, study_only): source_results.append({"repo": repo, "status": "REFUSED_LICENSE", "license": lic}); continue
            dst = cache / repo.replace("/", "__"); cr = clone_repo(repo, dst, allow_network)
            if not cr["ok"]: source_results.append({"repo": repo, "status": "CLONE_BLOCKED", "detail": cr}); continue
            stats = ingest_repo(con, writer, dst, repo=repo, license=lic, study_only=study_only)
            con.execute("INSERT OR REPLACE INTO sources(repo,status,license,records,bytes,detail) VALUES(?,?,?,?,?,?)", (repo, "INGESTED", lic, stats["records"], stats["bytes"], json.dumps(stats))); con.commit()
            source_results.append({"repo": repo, "status": "INGESTED", **stats})
        shards = writer.close(); counts = dict(con.execute("SELECT split,count(*) FROM docs GROUP BY split").fetchall()); bytes_by_split = dict(con.execute("SELECT split,sum(bytes) FROM docs GROUP BY split").fetchall())
        body = {"schema": SCHEMA, "sources": source_results, "counts": counts, "bytes_by_split": bytes_by_split, "shards": shards, "documents": sum(counts.values()), "bytes": sum(int(v or 0) for v in bytes_by_split.values())}
        body["sha256"] = hashlib.sha256(canonical(body)).hexdigest(); (out / "manifest.json").write_text(json.dumps(body, indent=2), encoding="utf-8"); (out / "build-receipt.json").write_text(json.dumps(receipt("corpus_stream.build", body), indent=2), encoding="utf-8"); return body
    finally:
        try: writer.close()
        except Exception: pass
        con.close()


def court() -> dict[str, Any]:
    import tempfile
    with tempfile.TemporaryDirectory(prefix="archie-corpus-stream-") as td:
        root = Path(td); repo = root / "repo"; repo.mkdir(); (repo / "a.py").write_text("print('a')\n", encoding="utf-8"); (repo / "b.py").write_text("print('a')\r\n", encoding="utf-8")
        con = open_db(root / "out" / "corpus.db"); writer = ShardWriter(root / "out" / "shards", 1024); stats = ingest_repo(con, writer, repo, repo="x/y", license="MIT"); shards = writer.close(); count = con.execute("SELECT count(*) FROM docs").fetchone()[0]; con.close()
        return receipt("corpus_stream.court", {"passes": count == 1 and stats["duplicates"] == 1 and bool(shards), "documents": count, "duplicates": stats["duplicates"]})


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--plan", type=Path, required=True); ap.add_argument("--cache", type=Path, required=True); ap.add_argument("--out", type=Path, required=True); ap.add_argument("--allow-network", action="store_true"); ap.add_argument("--max-sources", type=int, default=999); ap.add_argument("--reserve-gib", type=float, default=8); ns = ap.parse_args(); print(json.dumps(build(ns.plan, ns.cache, ns.out, allow_network=ns.allow_network, max_sources=ns.max_sources, reserve_gib=ns.reserve_gib), indent=2)); return 0
if __name__ == "__main__": raise SystemExit(main())
