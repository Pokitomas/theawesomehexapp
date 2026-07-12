#!/usr/bin/env python3
from __future__ import annotations

import glob
import json
import subprocess
from pathlib import Path

ROOT = Path("dist")
DATA = ROOT / "data"


def load(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


manifest = load(DATA / "manifest.json")
mix = load(DATA / "mix.json")
authors = load(DATA / "author-index.json")

require(manifest.get("count") == 1_000_000, "candidate count mismatch")
require(manifest.get("version") == 6, "manifest version mismatch")
corpus = manifest.get("corpus", {})
require(corpus.get("mode") == "general-content-model", "wrong corpus mode")
require(corpus.get("categories") is False, "category mode leaked back in")
require(corpus.get("actualSources") is True, "source provenance flag missing")
for content_type, floor in (("article", 500), ("forum", 300), ("social", 150)):
    require(corpus.get("uniqueByType", {}).get(content_type, 0) > floor, f"too few {content_type} records")

require(
    mix.get("candidateByType") == {"article": 333334, "forum": 333333, "social": 333333},
    "candidate type split mismatch",
)
chunks = list(DATA.glob("[0-9][0-9][0-9][0-9][0-9][0-9].json"))
require(len(chunks) == 977, "candidate chunk count mismatch")

rows: list[dict] = []
for path in sorted(glob.glob(str(DATA / "content" / "*.json"))):
    rows.extend(load(Path(path)))
require(rows, "content shards missing")
require(all("c" not in row for row in rows), "category field leaked into content records")
by_type = {0: [], 1: [], 2: []}
for row in rows:
    by_type[row["ty"]].append(row)
require(any(row.get("b") for row in by_type[0]), "article bodies missing")
require(any(row.get("r") for row in by_type[1]), "forum replies missing")
require(any(row.get("tx") or row.get("m") for row in by_type[2]), "social content missing")
require(all(row.get("u") for row in rows), "canonical source URL missing")
require(sum(bool(row.get("x")) for row in rows) > len(rows) * 0.7, "source provenance too sparse")

profile = manifest.get("profileSystem", {})
require(profile.get("schema") == 2, "profile schema mismatch")
require(profile.get("localFirst") is True, "local-first profile flag missing")
require(isinstance(authors, list) and authors, "author index missing")
require(len(authors) == profile.get("authorProfiles"), "author profile count mismatch")
for author_id, author in enumerate(authors):
    record_ids = author.get("r")
    require(isinstance(record_ids, list) and record_ids, f"author {author_id} owns no records")
    require(all(isinstance(record_id, int) and 0 <= record_id < len(rows) for record_id in record_ids), f"author {author_id} has invalid record ids")
    require(isinstance(author.get("t"), list) and len(author["t"]) == 3, f"author {author_id} type summary invalid")
    require(isinstance(author.get("s"), dict), f"author {author_id} source summary invalid")

required_customization = {
    "identity",
    "generated-avatar",
    "generated-cover",
    "image-upload",
    "theme",
    "density",
    "layout",
    "badges",
    "pinned-records",
    "collections",
    "following",
    "export-import",
}
require(required_customization <= set(profile.get("customization", [])), "profile customization surface incomplete")

for relative in (
    "profile.js",
    "profile.css",
    "assets/sideways-mark.svg",
    "assets/sideways-mask.svg",
    "assets/site.webmanifest",
):
    require((ROOT / relative).is_file(), f"missing profile asset: {relative}")

subprocess.run(["node", "--check", str(ROOT / "app.js")], check=True)
subprocess.run(["node", "--check", str(ROOT / "profile.js")], check=True)

print(json.dumps({
    "candidates": manifest["count"],
    "authors": len(authors),
    "profileSchema": profile["schema"],
    "customization": profile["customization"],
}, indent=2))
