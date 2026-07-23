#!/usr/bin/env python3
"""Evaluate world-state transfer and language retention against its source shell."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from archie_hybrid_core import ArchieHybridLM, ModelConfig, PAD_ID
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from archie_world_state_core import MODEL_SCHEMA, ArchieWorldStateLM, WorldStateConfig
from evaluate_world_state_transfer import evaluate as evaluate_transfer

SCHEMA = "archie-world-state-breakthrough-receipt/v1"


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_base(path: pathlib.Path, device: torch.device) -> tuple[ArchieHybridLM, dict[str, Any]]:
    payload = torch.load(path, map_location=device, weights_only=False)
    config = payload.get("config", payload.get("model_config"))
    state = payload.get("model")
    if not isinstance(config, dict) or not isinstance(state, dict):
        raise ValueError("base model is incomplete")
    model = ArchieHybridLM(ModelConfig(**config)).to(device)
    model.load_state_dict(state)
    model.eval()
    return model, payload


def load_candidate(
    path: pathlib.Path, device: torch.device
) -> tuple[ArchieWorldStateLM, dict[str, Any]]:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != MODEL_SCHEMA:
        raise ValueError("candidate is not an Archie world-state model")
    model = ArchieWorldStateLM(WorldStateConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    return model, payload


def next_token_nats(
    logits: torch.Tensor, tokens: torch.Tensor, byte_lengths: torch.Tensor
) -> tuple[float, int, int]:
    targets = tokens[:, 1:]
    losses = F.cross_entropy(
        logits[:, :-1].float().reshape(-1, logits.size(-1)),
        targets.reshape(-1),
        ignore_index=PAD_ID,
        reduction="none",
    ).reshape_as(targets)
    valid = targets.ne(PAD_ID)
    return (
        float(losses[valid].sum().cpu()),
        int(valid.sum().cpu()),
        int(byte_lengths[targets][valid].sum().cpu()),
    )


@torch.no_grad()
def compare_retention(
    base: ArchieHybridLM,
    candidate: ArchieWorldStateLM,
    corpus_path: pathlib.Path,
    tokenizer_metadata: dict[str, Any],
    *,
    seq_len: int,
    batches: int,
    batch_size: int,
    seed: int,
    device: torch.device,
) -> dict[str, Any]:
    tokens = np.memmap(corpus_path, dtype="<u2", mode="r")
    if len(tokens) <= seq_len + 1:
        raise ValueError("retention corpus is shorter than one sequence")
    maximum = len(tokens) - seq_len - 1
    rng = random.Random(seed)
    byte_lengths = torch.tensor(token_byte_lengths(tokenizer_metadata), device=device)
    totals = {
        "base_nats": 0.0,
        "candidate_nats": 0.0,
        "tokens": 0,
        "bytes": 0,
    }
    for _ in range(batches):
        rows = []
        for _ in range(batch_size):
            offset = rng.randint(0, maximum)
            rows.append(np.asarray(tokens[offset:offset + seq_len + 1], dtype=np.int64))
        batch = torch.from_numpy(np.stack(rows)).to(device)
        base_logits = base(batch)["logits"]
        candidate_logits = candidate(batch)["logits"]
        base_nats, token_count, byte_count = next_token_nats(
            base_logits, batch, byte_lengths
        )
        candidate_nats, candidate_tokens, candidate_bytes = next_token_nats(
            candidate_logits, batch, byte_lengths
        )
        if token_count != candidate_tokens or byte_count != candidate_bytes:
            raise AssertionError("retention accounting diverged")
        totals["base_nats"] += base_nats
        totals["candidate_nats"] += candidate_nats
        totals["tokens"] += token_count
        totals["bytes"] += byte_count
    denominator = max(totals["bytes"] * math.log(2.0), 1e-12)
    base_bpb = totals["base_nats"] / denominator
    candidate_bpb = totals["candidate_nats"] / denominator
    regression = (candidate_bpb - base_bpb) / max(base_bpb, 1e-12)
    return {
        "base_bits_per_byte": base_bpb,
        "candidate_bits_per_byte": candidate_bpb,
        "relative_regression": regression,
        "tokens": totals["tokens"],
        "bytes": totals["bytes"],
        "sequence_length": seq_len,
        "batches": batches,
        "batch_size": batch_size,
        "seed": seed,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--candidate-model", required=True)
    parser.add_argument("--suite", required=True)
    parser.add_argument("--eval-corpus", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--minimum-reset-gain", type=float, default=0.01)
    parser.add_argument("--minimum-wrong-gain", type=float, default=0.01)
    parser.add_argument("--maximum-retention-regression", type=float, default=0.05)
    parser.add_argument("--retention-seq-len", type=int, default=512)
    parser.add_argument("--retention-batches", type=int, default=24)
    parser.add_argument("--retention-batch-size", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260723)
    args = parser.parse_args()

    device = torch.device(args.device)
    base_path = pathlib.Path(args.base_model).resolve()
    candidate_path = pathlib.Path(args.candidate_model).resolve()
    suite_path = pathlib.Path(args.suite).resolve()
    eval_path = pathlib.Path(args.eval_corpus).resolve()
    output_path = pathlib.Path(args.output).resolve()

    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    candidate_digest = sha256_file(candidate_path)
    if suite.get("bound_model_sha256") != candidate_digest:
        raise ValueError("transfer suite is not bound to the exact candidate model")
    if suite.get("generated_after_model") is not True:
        raise ValueError("transfer suite does not prove post-training generation")

    base, base_payload = load_base(base_path, device)
    candidate, candidate_payload = load_candidate(candidate_path, device)
    base_tokenizer = base_payload.get("tokenizer")
    candidate_tokenizer = candidate_payload.get("tokenizer")
    if not isinstance(base_tokenizer, dict) or base_tokenizer != candidate_tokenizer:
        raise ValueError("base and candidate tokenizer metadata differ")
    tokenizer_from_metadata(base_tokenizer)

    maximum_context = min(base.cfg.max_seq_len, candidate.cfg.max_seq_len)
    if args.retention_seq_len + 1 > maximum_context:
        raise ValueError("retention sequence exceeds model context")

    transfer = evaluate_transfer(
        candidate_path,
        suite_path,
        device,
        args.minimum_reset_gain,
        args.minimum_wrong_gain,
    )
    retention = compare_retention(
        base,
        candidate,
        eval_path,
        base_tokenizer,
        seq_len=args.retention_seq_len,
        batches=args.retention_batches,
        batch_size=args.retention_batch_size,
        seed=args.seed,
        device=device,
    )
    passed = (
        bool(transfer["metrics"]["passed"])
        and retention["relative_regression"] <= args.maximum_retention_regression
    )
    receipt = {
        "schema": SCHEMA,
        "base_model_sha256": sha256_file(base_path),
        "candidate_model_sha256": candidate_digest,
        "suite_sha256": sha256_file(suite_path),
        "eval_corpus_sha256": sha256_file(eval_path),
        "transfer": transfer,
        "retention": retention,
        "thresholds": {
            "minimum_reset_gain": args.minimum_reset_gain,
            "minimum_wrong_gain": args.minimum_wrong_gain,
            "maximum_retention_regression": args.maximum_retention_regression,
        },
        "passed": passed,
        "promotion": "breakthrough-candidate" if passed else "falsified-or-incomplete",
        "claim_boundary": (
            "Passing means this exact candidate used post-training temporary state better than "
            "reset and wrong state while staying inside the declared language-retention bound. "
            "It still requires replication and throughput evidence before admission."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(
        json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
