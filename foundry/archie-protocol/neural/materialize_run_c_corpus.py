#!/usr/bin/env python3
"""Materialize the exact 925-row governed route corpus used by run C.

The source rows were reconstructed by executing the committed
prepare-route-data.mjs algorithm over Archie-Audit.zip whose full archive digest
is recorded below. The compact payload is split into small independently bound
text chunks, then checked again before and after decompression.
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
EXPECTED_CHUNKS = {
    "part-00": "680e81404bf64a481b296ae6c7560f90f1b652bba9eb22c4a55850f9227c5984",
    "part-01": "70c63f07880cd747d7c34b393b261409abca20be758d239761d12bb1dca03f6f",
    "part-02": "ab1c3319844196f330fe6cbf685365916cec43eeef49487b32875bea5cbd0419",
    "part-03": "69f752699d4faa5f2fa690df22d06a1af9bbba2a38453c0fecf43c1205140591",
    "part-04": "f9acbb14f1077cad38602ce6ff20101bf56d533db3a5b036d1c72868e7196046",
    "part-05": "8c469d43e0cae3012fb03091b21f19dc20abc3389383515e742c1312d5f43ffc",
}
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


def read_encoded_payload(path: Path) -> str:
    if path.is_file():
        return "".join(path.read_text().split())
    if not path.is_dir():
        raise SystemExit(f"run-C payload path does not exist: {path}")
    names = [entry.name for entry in sorted(path.iterdir()) if entry.is_file()]
    if names != list(EXPECTED_CHUNKS):
        raise SystemExit(f"run-C payload chunk set mismatch: {names}")
    encoded_parts = []
    for name in names:
        raw = (path / name).read_bytes()
        if sha256(raw) != EXPECTED_CHUNKS[name]:
            raise SystemExit(f"run-C payload chunk digest mismatch: {name}")
        encoded_parts.append(raw.decode("ascii"))
    return "".join("".join(part.split()) for part in encoded_parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--payload",
        default=str(Path(__file__).resolve().parent / "evidence" / "run-c-corpus.parts"),
    )
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", default="")
    args = parser.parse_args()

    encoded = read_encoded_payload(Path(args.payload))
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
        "payload_chunks": EXPECTED_CHUNKS,
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
