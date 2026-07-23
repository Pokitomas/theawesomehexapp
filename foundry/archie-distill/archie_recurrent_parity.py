#!/usr/bin/env python3
"""Owner-local exact-checkpoint parity receipt for Archie recurrence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
from typing import Any

import numpy as np
import torch

from archie_baseline_identity import BASELINE_EXPORT_SHA256, load_baseline_export, stable_json
from archie_fixed_eval import corpus_metadata
from archie_recurrent_export import load_recurrent_export

RECEIPT_SCHEMA = "archie-recurrent-parity-receipt/v1"


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


@torch.no_grad()
def parity_receipt(
    model_path: pathlib.Path,
    corpus_path: pathlib.Path,
    output_path: pathlib.Path,
    *,
    offset: int,
    length: int,
    tolerance: float,
    device_name: str,
    expected_model_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> dict[str, Any]:
    if offset < 0 or length < 2:
        raise ValueError("offset must be nonnegative and length must be at least two")
    metadata = corpus_metadata(corpus_path)
    if offset + length > int(metadata["token_count"]):
        raise ValueError("parity slice exceeds corpus bounds")
    device = torch.device(device_name)
    baseline, baseline_identity = load_baseline_export(
        model_path, device=device, expected_sha256=expected_model_sha256
    )
    recurrent, recurrent_identity = load_recurrent_export(
        model_path, device=device, expected_sha256=expected_model_sha256
    )
    if baseline_identity["config_digest"] != recurrent_identity["config_digest"]:
        raise ValueError("baseline and recurrent config identities differ")
    if length > baseline.cfg.max_seq_len:
        raise ValueError("parity slice exceeds the model maximum sequence length")
    corpus = np.memmap(corpus_path, dtype="<u2", mode="r")
    ids = torch.from_numpy(np.asarray(corpus[offset:offset + length], dtype=np.int64)).to(device)[None]
    full_logits = baseline(ids)["logits"].float()
    incremental_logits, _, _ = recurrent.step(ids)
    incremental_logits = incremental_logits.float()
    error = (full_logits - incremental_logits).abs()
    maximum = float(error.max().cpu())
    mean = float(error.mean().cpu())
    passed = maximum <= tolerance
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "passed": passed,
        "model_sha256": baseline_identity["export_sha256"],
        "source_core_blob": baseline_identity["source_core_blob"],
        "config_digest": baseline_identity["config_digest"],
        "corpus_sha256": metadata["sha256"],
        "corpus_schema": metadata["schema"],
        "slice": {"offset": offset, "length": length},
        "maximum_logit_error": maximum,
        "mean_logit_error": mean,
        "tolerance": tolerance,
        "device": str(device),
        "promotion": "research-only-not-admitted",
    }
    receipt["receipt_digest"] = digest(receipt)
    atomic_json(output_path, receipt)
    if not passed:
        raise SystemExit(
            f"exact-checkpoint recurrence parity failed: {maximum:.8g} > {tolerance:.8g}"
        )
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--offset", type=int, required=True)
    parser.add_argument("--length", type=int, default=512)
    parser.add_argument("--tolerance", type=float, default=1e-4)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    receipt = parity_receipt(
        pathlib.Path(args.model), pathlib.Path(args.corpus), pathlib.Path(args.output),
        offset=args.offset, length=args.length, tolerance=args.tolerance,
        device_name=args.device,
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
