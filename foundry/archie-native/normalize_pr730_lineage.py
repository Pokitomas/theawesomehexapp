#!/usr/bin/env python3
"""Normalize successor lineage fields after exact PR #730 continuation.

The current trainer constructs a fresh module before loading a parent checkpoint. Its
successor tensor state and optimizer state are correctly inherited, but the transient
pre-load random digest must not replace the lineage's generation-zero origin digest in
the final checkpoint or receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib

import torch

SCHEMA = "archie-agent-teacher-policy/v1"
RECEIPT_SCHEMA = "archie-agent-teacher-policy-receipt/v1"


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", required=True)
    parser.add_argument("--successor", required=True)
    args = parser.parse_args()

    parent_path = pathlib.Path(args.parent).resolve()
    successor_path = pathlib.Path(args.successor).resolve()
    receipt_path = successor_path.with_suffix(successor_path.suffix + ".receipt.json")

    parent = torch.load(parent_path, map_location="cpu", weights_only=False)
    successor = torch.load(successor_path, map_location="cpu", weights_only=False)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))

    if parent.get("schema") != SCHEMA or successor.get("schema") != SCHEMA:
        raise ValueError("checkpoint schema mismatch")
    if receipt.get("schema") != RECEIPT_SCHEMA:
        raise ValueError("receipt schema mismatch")
    if int(parent.get("generation", -1)) + 1 != int(successor.get("generation", -1)):
        raise ValueError("successor generation mismatch")
    parent_file_sha256 = sha256_file(parent_path)
    if successor.get("parent_file_sha256") != parent_file_sha256:
        raise ValueError("successor parent digest mismatch")
    if receipt.get("parent_file_sha256") != parent_file_sha256:
        raise ValueError("receipt parent digest mismatch")
    if successor.get("action_vocabulary") != parent.get("action_vocabulary"):
        raise ValueError("action vocabulary changed during continuation")
    if successor.get("config") != parent.get("config"):
        raise ValueError("architecture changed during continuation")

    origin_digest = parent.get("generation_zero_random_tensor_digest")
    if not isinstance(origin_digest, str) or len(origin_digest) != 64:
        raise ValueError("valid generation-zero origin digest required")

    successor["generation_zero_random_tensor_digest"] = origin_digest
    torch.save(successor, successor_path)
    successor_file_sha256 = sha256_file(successor_path)

    receipt["generation_zero_random_tensor_digest"] = origin_digest
    receipt["checkpoint_file_sha256"] = successor_file_sha256
    receipt["lineage_normalized"] = True
    receipt["lineage_normalizer"] = "normalize_pr730_lineage.py/v1"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "schema": "pr730-lineage-normalization/v1",
        "parent_file_sha256": parent_file_sha256,
        "successor_file_sha256": successor_file_sha256,
        "generation_zero_random_tensor_digest": origin_digest,
        "lineage_normalized": True,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
