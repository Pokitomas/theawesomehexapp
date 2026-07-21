#!/usr/bin/env python3
"""Materialize the exact radial-probe sources beside this sealed payload."""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

PAYLOAD_SHA256 = "b55b7dd8f34ba19bc35dc3a0e6e16c10f1dd5389eff438723793427560431ded"
FILES = {
    "radial_campaign.py": "d243d5ea38e3baf22e0018af45775433ee3d99afba5646ed5edcc5f220d1e4ba",
    "test_radial_campaign.py": "9cbab554d41f4a7896056e1acbf5ba20d8ac4ef7866b8413a9fe136a08fb1c53",
}


def main() -> None:
    root = Path(__file__).resolve().parent
    parts = sorted(root.glob("payload.part*"))
    if len(parts) != 1:
        raise SystemExit(f"expected 1 radial payload part, found {len(parts)}")
    raw = base64.b64decode("".join(part.read_text().strip() for part in parts))
    if hashlib.sha256(raw).hexdigest() != PAYLOAD_SHA256:
        raise SystemExit("radial payload digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)), mode="r:") as archive:
        archive.extractall(root, filter="data")
    observed = {
        name: hashlib.sha256((root / name).read_bytes()).hexdigest()
        for name in FILES
    }
    if observed != FILES:
        raise SystemExit("materialized radial source digest mismatch")
    print(json.dumps({
        "schema": "archie-radial-materialization/v1",
        "payload_sha256": PAYLOAD_SHA256,
        "files": observed,
        "promotion": "not-admitted",
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
