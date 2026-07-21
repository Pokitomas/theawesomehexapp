#!/usr/bin/env python3
"""Materialize the exact full-budget campaign sources into the benchmark root."""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

PAYLOAD_SHA256 = "461e0040f0b0369554b3bab4601ff797059819bb5b8e5516c192aaaf543bfa98"
FILES = {
    "FULL_BUDGET_CAMPAIGN.md": "8d52bc3ca7f285fd082db12654d544fc94b41eb9031261344aca88c013f7ab13",
    "full_budget_campaign.py": "9134d00e23bb1567f1506b71f30f60c8601fffc66ec82a956da577940a1d571e",
    "full_budget_profile.json": "61fe8bec72c208705f131b794c20f8a700759f95d5882ae0d07069b869d4fd53",
    "test_full_budget_campaign.py": "d42970452844991a2b7a0cae43ce0abe2bb6abd5c84badff35323a6b4971f19a",
}


def main() -> None:
    payload_root = Path(__file__).resolve().parent
    benchmark_root = payload_root.parent
    parts = sorted(payload_root.glob("payload.part*"))
    if len(parts) != 1:
        raise SystemExit(f"expected 1 campaign payload part, found {len(parts)}")
    raw = base64.b64decode("".join(part.read_text().strip() for part in parts))
    if hashlib.sha256(raw).hexdigest() != PAYLOAD_SHA256:
        raise SystemExit("campaign payload digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)), mode="r:") as archive:
        archive.extractall(benchmark_root, filter="data")
    observed = {
        name: hashlib.sha256((benchmark_root / name).read_bytes()).hexdigest()
        for name in FILES
    }
    if observed != FILES:
        raise SystemExit("materialized campaign file digest mismatch")
    print(json.dumps({
        "schema": "archie-causal-mechanism-materialization/v2",
        "payload_sha256": PAYLOAD_SHA256,
        "files": observed,
        "promotion": "not-admitted",
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
