#!/usr/bin/env python3
"""Restore the digest-bound neurocompiler trainer from split gzip/base64 parts."""
from __future__ import annotations

import base64
import gzip
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPECTED_SHA256 = "ae969bf646741db209f65fe452d08f1e071b0e292a6ab729906342a71200b658"


def main() -> None:
    parts = sorted(ROOT.glob("train.part*"))
    if [part.name for part in parts] != ["train.part00", "train.part01", "train.part02"]:
        raise SystemExit(f"unexpected trainer parts: {[part.name for part in parts]}")
    encoded = b"".join(part.read_bytes() for part in parts)
    payload = gzip.decompress(base64.b64decode(encoded))
    observed = hashlib.sha256(payload).hexdigest()
    if observed != EXPECTED_SHA256:
        raise SystemExit(f"trainer source digest mismatch: {observed}")
    target = ROOT / "train_neurocompiler.py"
    target.write_bytes(payload)
    print(f"restored {target.name} sha256:{observed}")


if __name__ == "__main__":
    main()
