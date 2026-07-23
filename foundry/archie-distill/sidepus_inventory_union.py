#!/usr/bin/env python3
"""Union Sidepus inventories without copying payload objects."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tempfile
from collections import Counter
from typing import Any

INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
RECEIPT_SCHEMA = "sidepus-inventory-union-receipt/v1"


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def union(inputs: list[pathlib.Path], output: pathlib.Path) -> dict[str, Any]:
    if len(inputs) < 1:
        raise ValueError("at least one inventory is required")
    sources: list[dict[str, Any]] = []
    records: dict[str, dict[str, Any]] = {}
    counts = Counter()
    for raw_path in inputs:
        path = raw_path.expanduser().resolve()
        sources.append({"path": str(path), "sha256": sha256_file(path)})
        with path.open("r", encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict) or row.get("schema") != INVENTORY_SCHEMA:
                    raise ValueError(f"{path}:{number} is not a Sidepus inventory record")
                record_id = str(row.get("record_id", "")).strip()
                if not record_id:
                    raise ValueError(f"{path}:{number} has no record_id")
                existing = records.get(record_id)
                if existing is not None:
                    if stable_json(existing) != stable_json(row):
                        raise ValueError(f"conflicting duplicate record_id: {record_id}")
                    counts["identical_duplicates"] += 1
                    continue
                records[record_id] = row
                counts[f"domain:{row.get('domain', 'unknown')}"] += 1
                counts[f"medium:{row.get('medium', 'unknown')}"] += 1
    if not records:
        raise ValueError("union inventory is empty")
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=output.parent, mode="w", encoding="utf-8", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            for record_id in sorted(records):
                encoded = stable_json(records[record_id])
                handle.write(encoded + "\n")
                hasher.update((encoded + "\n").encode())
            handle.flush(); os.fsync(handle.fileno()); os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "inputs": sources,
        "output": str(output),
        "output_sha256": sha256_file(output),
        "output_digest": hasher.hexdigest(),
        "records": len(records),
        "counts": dict(sorted(counts.items())),
        "claim_boundary": (
            "The union preserves records and object references exactly and copies no payload bytes. "
            "It does not resolve rights, quality, semantic conflicts, or curriculum priority."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    receipt_path = output.with_suffix(output.suffix + ".receipt.json")
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", action="append", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    union([pathlib.Path(value) for value in args.inventory], pathlib.Path(args.output))


if __name__ == "__main__":
    main()
