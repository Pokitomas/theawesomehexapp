from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from core import canonical, receipt

SCHEMA = "archie-corpus-manifest/v1"
DEFAULT_EXTENSIONS = (
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".c", ".cc", ".cpp",
    ".h", ".hpp", ".md", ".json", ".yaml", ".yml", ".html", ".css", ".sh",
)


@dataclass(frozen=True)
class Record:
    id: str
    source: str
    license: str
    split: str
    kind: str
    sha256: str
    bytes: int
    contamination: tuple[str, ...] = ()
    metadata: dict[str, Any] | None = None


def norm_text(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+$", "", s, flags=re.M)
    return s.strip() + "\n"


def stable_split(key: str) -> str:
    n = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 1000
    return "train" if n < 900 else ("validation" if n < 950 else "heldout")


def make_record(
    text: str,
    *,
    source: str,
    license: str,
    kind: str,
    tags: Iterable[str] = (),
    metadata: dict[str, Any] | None = None,
) -> tuple[Record, bytes]:
    b = norm_text(text).encode("utf-8")
    h = hashlib.sha256(b).hexdigest()
    split = stable_split(source + "\0" + h)
    return Record(
        h[:24], source, license, split, kind, h, len(b), tuple(sorted(set(tags))), metadata
    ), b


def build_manifest(records: list[Record]) -> dict[str, Any]:
    ids = [r.id for r in records]
    train = {r.id for r in records if r.split == "train"}
    held = {r.id for r in records if r.split == "heldout"}
    payload = {
        "schema": SCHEMA,
        "records": [asdict(r) for r in records],
        "counts": {
            s: sum(r.split == s for r in records)
            for s in ("train", "validation", "heldout")
        },
        "bytes": sum(r.bytes for r in records),
        "duplicate_ids": len(ids) != len(set(ids)),
        "train_heldout_overlap": sorted(train & held),
    }
    payload["sha256"] = hashlib.sha256(canonical(payload)).hexdigest()
    return payload


def ingest_tree(
    root: Path,
    *,
    source_prefix: str,
    license: str,
    extensions: tuple[str, ...] = DEFAULT_EXTENSIONS,
) -> tuple[list[Record], dict[str, bytes]]:
    records: list[Record] = []
    blobs: dict[str, bytes] = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in extensions:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except Exception:
            continue
        rel = p.relative_to(root).as_posix()
        rec, b = make_record(
            text,
            source=f"{source_prefix}/{rel}",
            license=license,
            kind=p.suffix.lower().lstrip("."),
        )
        if rec.sha256 in blobs:
            continue
        records.append(rec)
        blobs[rec.sha256] = b
    return records, blobs


def contamination_filter(
    records: list[Record],
    forbidden_hashes: set[str],
    forbidden_terms: Iterable[str] = (),
) -> list[Record]:
    terms = tuple(t.lower() for t in forbidden_terms if t)
    out: list[Record] = []
    for r in records:
        flags = list(r.contamination)
        if r.sha256 in forbidden_hashes:
            flags.append("heldout-hash")
        if terms and any(t in r.source.lower() for t in terms):
            flags.append("heldout-source-term")
        out.append(
            Record(
                r.id,
                r.source,
                r.license,
                r.split,
                r.kind,
                r.sha256,
                r.bytes,
                tuple(sorted(set(flags))),
                r.metadata,
            )
        )
    return out


def court() -> dict[str, Any]:
    a, _ = make_record("alpha\n", source="permissive/a.py", license="MIT", kind="py")
    b, _ = make_record("beta\n", source="permissive/b.py", license="MIT", kind="py")
    dup, _ = make_record(
        "alpha\r\n", source="permissive/a-copy.py", license="MIT", kind="py"
    )
    recs = contamination_filter([a, b, dup], {b.sha256})
    manifest = build_manifest(recs)
    passes = (
        a.sha256 == dup.sha256
        and any("heldout-hash" in r.contamination for r in recs)
        and not manifest["train_heldout_overlap"]
    )
    return receipt(
        "corpus.court",
        {
            "passes": passes,
            "normalization_dedup_signal": a.sha256 == dup.sha256,
            "manifest_sha256": manifest["sha256"],
            "counts": manifest["counts"],
        },
    )


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
