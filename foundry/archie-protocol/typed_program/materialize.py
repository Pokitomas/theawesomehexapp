#!/usr/bin/env python3
"""Restore digest-bound Archie typed-program sources from split gzip/base64 bundles."""
from __future__ import annotations

import base64
import gzip
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUNDLES = {
    "typed_program_student.py": ("student.part", "d10df269c1135b3ec98c94b109297c661d6b9f0bd75a5c5315b72d547d5c450c"),
    "typed_program_blind_pack.py": ("blind.part", "f36643e6b04944677e9e0611b68b76d43d9e2d7c02335ee565e4e780ca5733a3"),
}


def main() -> None:
    for output_name, (prefix, expected) in BUNDLES.items():
        parts = sorted(ROOT.glob(prefix + "*"))
        if not parts:
            raise SystemExit(f"{output_name}: no bundle parts")
        encoded = b"".join(part.read_bytes() for part in parts)
        payload = gzip.decompress(base64.b64decode(encoded))
        observed = hashlib.sha256(payload).hexdigest()
        if observed != expected:
            raise SystemExit(f"{output_name}: source digest mismatch {observed}")
        (ROOT / output_name).write_bytes(payload)
        print(f"restored {output_name} sha256:{observed}")


if __name__ == "__main__":
    main()
