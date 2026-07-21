#!/usr/bin/env python3
"""Materialize the exact 925-row governed route corpus used by run C.

The source rows were reconstructed by executing the committed
prepare-route-data.mjs algorithm over Archie-Audit.zip whose full archive digest
is recorded below. The compact payload is checked before and after decompression,
and its route/source composition is fixed.
"""
from __future__ import annotations

import argparse
import base64
import collections
import gzip
import hashlib
import json
from pathlib import Path

AUDIT_ARCHIVE_SHA256 = "a190c28ceeb6292ae6857a6e885ec32810cf16737ad950826bfc70531d48bc15"
PAYLOAD_SHA256 = "4be2ef30dcf2423c6700b1367ba7f249608ed61374345738cdee91140b2e919d"
CORPUS_SHA256 = "38d9df9c6f59d37c669cc3c3385172d2503995f5dc31e665d70941eb62ef8c57"
EXPECTED_ROWS = 925
EXPECTED_ROUTE_COUNTS = {
    "checklist": 103,
    "clarify": 86,
    "compound": 150,
    "decision": 133,
    "errands": 38,
    "event": 37,
    "message": 63,
    "next_action": 85,
    "objective": 58,
    "plan": 44,
    "study": 37,
    "summary": 91,
}
EXPECTED_SOURCE_COUNTS = {
    "governed-corpus": 482,
    "router-real-v1": 48,
    "repo-corpus": 186,
    "authored": 83,
    "redteam-v1": 48,
    "synthesized-compound": 78,
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--payload",
        default=str(Path(__file__).resolve().parent / "evidence" / "run-c-governed-route-corpus.json.gz.b64"),
    )
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", default="")
    args = parser.parse_args()

    encoded = "".join(Path(args.payload).read_text().split())
    compressed = base64.b64decode(encoded, validate=True)
    if sha256(compressed) != PAYLOAD_SHA256:
        raise SystemExit("run-C corpus payload digest mismatch")
    raw = gzip.decompress(compressed)
    if sha256(raw) != CORPUS_SHA256:
        raise SystemExit("run-C corpus digest mismatch")

    rows = json.loads(raw)
    if len(rows) != EXPECTED_ROWS:
        raise SystemExit(f"run-C corpus row mismatch: {len(rows)}")
    route_counts = dict(collections.Counter(row["route"] for row in rows))
    source_counts = dict(collections.Counter(row["source"] for row in rows))
    if route_counts != EXPECTED_ROUTE_COUNTS:
        raise SystemExit(f"run-C route composition mismatch: {route_counts}")
    if source_counts != EXPECTED_SOURCE_COUNTS:
        raise SystemExit(f"run-C source composition mismatch: {source_counts}")
    if any(set(row) != {"prompt", "route", "source"} for row in rows):
        raise SystemExit("run-C corpus row schema mismatch")

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(raw)
    manifest = {
        "schema": "archie-run-c-governed-corpus/v1",
        "source_archive": "Archie-Audit.zip",
        "source_archive_sha256": AUDIT_ARCHIVE_SHA256,
        "preparation_algorithm": "foundry/archie-protocol/prepare-route-data.mjs",
        "payload_sha256": PAYLOAD_SHA256,
        "corpus_sha256": CORPUS_SHA256,
        "rows": EXPECTED_ROWS,
        "route_counts": EXPECTED_ROUTE_COUNTS,
        "source_counts": EXPECTED_SOURCE_COUNTS,
        "claim": "Deterministic reconstruction of the exact audit-backed route corpus used by run C; run-D identity additionally requires matching run-C vocabulary and training configuration.",
    }
    target = Path(args.manifest) if args.manifest else output.with_suffix(".manifest.json")
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
