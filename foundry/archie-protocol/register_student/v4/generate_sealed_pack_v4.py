#!/usr/bin/env python3
"""Generate a fresh 1,800-row post-fix admission pack and bound manifest."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import secrets
import subprocess
import tempfile
from pathlib import Path

CONTROLLER_SHA256 = "e064bf0cf3bd94fe0808257c929c7238d9cc6de9af1d9f51bd1b77891616b5fc"
MODEL_SHA256 = "7a7f4619a9bb300ff5e690970663373d974fb0584a3b6b975cb1858f223a18b0"
ACCESS_CONTRACT = "seal job only; candidate commit fixed before generation; judge job opens artifact after upload"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate(generator: Path, output: Path, seed: int) -> list[dict]:
    subprocess.run(
        ["python3", str(generator), "--out", str(output), "--seed", str(seed)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    rows = json.loads(output.read_text())
    if len(rows) != 1584:
        raise SystemExit(f"unexpected generator row count: {len(rows)}")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--candidate-commit", default=os.environ.get("GITHUB_SHA", ""))
    args = parser.parse_args()
    if not args.candidate_commit:
        raise SystemExit("candidate commit is required")

    generator = Path("foundry/archie-protocol/register_student/sealed_pack.py")
    seeds = [secrets.randbits(63) for _ in range(3)]
    with tempfile.TemporaryDirectory(prefix="archie-register-v4-") as temp:
        temp_path = Path(temp)
        rows_a = generate(generator, temp_path / "a.json", seeds[0])
        rows_b = generate(generator, temp_path / "b.json", seeds[1])

    extra = rows_b[:216]
    for index, row in enumerate(extra):
        row["id"] = f"sealed-v4-extra-{index:04d}-{row['id']}"
    rows = rows_a + extra
    random.Random(seeds[2]).shuffle(rows)
    identifiers = [row["id"] for row in rows]
    if len(rows) != 1800 or len(identifiers) != len(set(identifiers)):
        raise SystemExit("sealed pack cardinality or ID uniqueness failure")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    pack_path = args.output_dir / "sealed-pack-v4.json"
    payload = (json.dumps(rows, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
    pack_path.write_bytes(payload)
    manifest = {
        "schema": "archie-register-sealed-admission-pack/v4",
        "rows": len(rows),
        "sha256": sha256(payload),
        "seed_commitments": [sha256(str(seed).encode()) for seed in seeds],
        "generator_sha256": sha256(generator.read_bytes()),
        "candidate_commit": args.candidate_commit,
        "controller_sha256": CONTROLLER_SHA256,
        "model_sha256": MODEL_SHA256,
        "generated_after_candidate_fixed": True,
        "access_contract": ACCESS_CONTRACT,
    }
    (args.output_dir / "sealed-pack-v4.json.manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
