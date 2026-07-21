#!/usr/bin/env python3
"""Materialize the exact causal-model productization sources."""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

PAYLOAD_SHA256 = "f983691aed8f7062e4a7a25f19683b00ac50307cf04db07e802d617c7c29775c"
FILES = {
    "winner_productization.py": "0c7c8550cdaaa9cfb214ebe4f60bdf6074fb3f813bfa9ce607354f1eb8ac91f9",
    "world_state_app.py": "bb57eec5495dfb1459aefe76fc1a464db9fd9964d18e78ef5e481d7ac83e46b0",
    "world_state_lab.html": "50d2646f50aa9b6cbf840530d2010ae158519b2e3135f30ee2518c75c1e95db2",
    "test_winner_productization.py": "fa8e49cfc7fc4849273fad1087674a6720dc5060bc846b1f8edc4fe6c0706305",
    "README.md": "f2c7b9f2ea31725f1aa645cde3117e7a442c7394b74effdb2c880a3cce84964d",
}


def main() -> None:
    root = Path(__file__).resolve().parent
    parts = sorted(root.glob("payload.part*"))
    if len(parts) != 1:
        raise SystemExit(f"expected 1 product payload part, found {len(parts)}")
    raw = base64.b64decode("".join(part.read_text(encoding="utf-8").strip() for part in parts))
    if hashlib.sha256(raw).hexdigest() != PAYLOAD_SHA256:
        raise SystemExit("product payload digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)), mode="r:") as archive:
        archive.extractall(root, filter="data")
    observed = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in FILES}
    if observed != FILES:
        raise SystemExit("materialized product file digest mismatch")
    print(json.dumps({
        "schema": "archie-causal-model-product-materialization/v1",
        "payload_sha256": PAYLOAD_SHA256,
        "files": observed,
        "promotion": "shadow-product-not-admitted",
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
