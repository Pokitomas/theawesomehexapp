#!/usr/bin/env python3
"""Materialize and verify the exact frozen Archie legacy route suites.

The payload is a deterministic gzip-compressed tar recovered from the user's
Archie-Audit.zip. It is split into independently digest-bound text chunks;
extraction is allowlisted and every resulting byte stream is bound again.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import tarfile
from pathlib import Path

PAYLOAD_SHA256 = "23ebfdf7a0eba98425d8e20e5bf0e89f181d81b087a5e2463be1fcb01e305771"
EXPECTED_CHUNKS = {
    "part-00": "84c5d34be3592c9584998c18d92992450f6a3531bf586cf907eba739c83ebb7c",
    "part-01": "d337f2dc90ddeaa72a595e05e58d3eafc621212e4562b31a05611e069bb0c377",
    "part-02": "c6192c2228771f7ff53ec540b9a33fbe488a9564ebbff58a3adb877e91aa89c9",
    "part-03": "bc32de3a892bd324fd352d3b42bbab6cf70eb616919d85c1c5195c818ff35397",
    "part-04": "7ea62654efcc8d5c4ba3f4075a4dd228a64513906d4ac8a3bab12ad0e34b2f24",
}
SUITES = {
    "router-v2-original-heldout.jsonl": {
        "rows": 498,
        "sha256": "188d67330955a67bdb24a1bb096f2910eaa13a268b48dde77216cdd4f8be40f5",
    },
    "router-real-v2-heldout.jsonl": {
        "rows": 60,
        "sha256": "72c0d30af384c42c54e244c6466f1ed710a1f58b157ed26cceb65f9d91068f64",
    },
    "router-real-v3-final.jsonl": {
        "rows": 48,
        "sha256": "cb9131eaa0888d14a8e68f83e0486221b9b3dc5bf5b31a0df1a1f016433594dd",
    },
}
AUDIT_ARCHIVE_SHA256 = "a190c28ceeb6292ae6857a6e885ec32810cf16737ad950826bfc70531d48bc15"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_encoded_payload(path: Path) -> str:
    if path.is_file():
        return "".join(path.read_text().split())
    if not path.is_dir():
        raise SystemExit(f"legacy suite payload path does not exist: {path}")
    names = [entry.name for entry in sorted(path.iterdir()) if entry.is_file()]
    if names != list(EXPECTED_CHUNKS):
        raise SystemExit(f"legacy suite payload chunk set mismatch: {names}")
    encoded_parts = []
    for name in names:
        raw = (path / name).read_bytes()
        if sha256(raw) != EXPECTED_CHUNKS[name]:
            raise SystemExit(f"legacy suite payload chunk digest mismatch: {name}")
        encoded_parts.append(raw.decode("ascii"))
    return "".join("".join(part.split()) for part in encoded_parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--payload",
        default=str(Path(__file__).resolve().parent / "evidence" / "legacy-suites.parts"),
    )
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", default="")
    args = parser.parse_args()

    encoded = read_encoded_payload(Path(args.payload))
    archive = base64.b64decode(encoded, validate=True)
    if sha256(archive) != PAYLOAD_SHA256:
        raise SystemExit("legacy suite payload digest mismatch")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    allowed = set(SUITES)
    seen: set[str] = set()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            if not member.isfile() or member.name not in allowed:
                raise SystemExit(f"unexpected legacy payload member: {member.name}")
            source = bundle.extractfile(member)
            if source is None:
                raise SystemExit(f"unable to read legacy payload member: {member.name}")
            data = source.read()
            expected = SUITES[member.name]
            if sha256(data) != expected["sha256"]:
                raise SystemExit(f"legacy suite digest mismatch: {member.name}")
            rows = sum(1 for line in data.splitlines() if line.strip())
            if rows != expected["rows"]:
                raise SystemExit(f"legacy suite row-count mismatch: {member.name}")
            (out / member.name).write_bytes(data)
            seen.add(member.name)
    if seen != allowed:
        raise SystemExit(f"legacy suite payload incomplete: {sorted(allowed - seen)}")

    manifest = {
        "schema": "archie-audit-legacy-suites/v1",
        "source_archive": "Archie-Audit.zip",
        "source_archive_sha256": AUDIT_ARCHIVE_SHA256,
        "payload_sha256": PAYLOAD_SHA256,
        "payload_chunks": EXPECTED_CHUNKS,
        "suites": SUITES,
        "rows": sum(item["rows"] for item in SUITES.values()),
        "claim": "Exact byte-for-byte legacy route suites recovered from the digest-matched audit archive.",
    }
    target = Path(args.manifest) if args.manifest else out / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
