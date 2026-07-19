#!/usr/bin/env python3
"""Transfer an explicit token-compute budget into Archie's causal-fork replay policy.

This wrapper does not invent a new tokenizer vocabulary. It converts a bounded
attention/token-compute allowance into deterministic replay-window parameters,
then delegates segmentation to ``information_budgeted_rslora.py`` so the exact
student tokenizer still owns byte-to-token behavior.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import subprocess
import sys
from dataclasses import asdict, dataclass
from typing import Any

SCHEMA = "archie-token-compute-transfer/v1"


@dataclass(frozen=True)
class ComputePolicy:
    max_seq_length: int
    prompt_replay_tokens: int
    prompt_head_tokens: int
    shared_prefix_replay_tokens: int
    max_divergence_tokens: int
    requested_attention_area: int
    effective_attention_area: int
    training_rows: int


def _clamp(value: int, lower: int, upper: int) -> int:
    return max(lower, min(upper, value))


def policy_from_token_compute(
    *,
    token_compute: int,
    training_rows: int,
    max_seq_cap: int = 2048,
    minimum_seq: int = 64,
) -> ComputePolicy:
    """Map total causal-fork attention area into a deterministic replay policy.

    Each pair has two arms, so a conservative per-row attention estimate is
    ``2 * sequence_length**2``. The resulting sequence width is split between
    prompt replay, shared chosen/rejected prefix, and supervised divergence.
    """
    if token_compute <= 0:
        raise ValueError("token_compute must be positive")
    if training_rows <= 0:
        raise ValueError("training_rows must be positive")
    if max_seq_cap < minimum_seq or minimum_seq < 16:
        raise ValueError("invalid sequence bounds")

    per_arm_area = token_compute / (2.0 * training_rows)
    width = _clamp(int(math.sqrt(per_arm_area)), minimum_seq, max_seq_cap)

    # Archie's fork replay emphasizes the causal divergence while preserving a
    # small head/tail prompt witness and the immediate shared target prefix.
    divergence = max(16, int(width * 0.52))
    shared = max(8, int(width * 0.14))
    prompt = max(16, width - divergence - shared)
    head = max(4, min(prompt, int(prompt * 0.125)))

    # Rounding can overrun the width by a few tokens. Trim prompt first because
    # divergence supervision is the information-bearing region.
    overflow = prompt + shared + divergence - width
    if overflow > 0:
        prompt = max(8, prompt - overflow)

    effective = training_rows * 2 * width * width
    return ComputePolicy(
        max_seq_length=width,
        prompt_replay_tokens=prompt,
        prompt_head_tokens=head,
        shared_prefix_replay_tokens=shared,
        max_divergence_tokens=divergence,
        requested_attention_area=token_compute,
        effective_attention_area=effective,
        training_rows=training_rows,
    )


def count_jsonl(path: pathlib.Path) -> int:
    with path.open("r", encoding="utf-8") as stream:
        return sum(1 for line in stream if line.strip())


def build_segment_command(args: argparse.Namespace, policy: ComputePolicy) -> list[str]:
    return [
        args.python,
        str(pathlib.Path(__file__).with_name("information_budgeted_rslora.py")),
        "segment",
        "--train", args.train,
        "--development", args.development,
        "--pair-receipt", args.pair_receipt,
        "--model-dir", args.model_dir,
        "--output", args.output,
        "--shards", str(args.shards),
        "--round", str(args.round),
        "--seed", str(args.seed),
        "--request-id", args.request_id,
        "--code-revision", args.code_revision,
        "--max-seq-length", str(policy.max_seq_length),
        "--prompt-replay-tokens", str(policy.prompt_replay_tokens),
        "--prompt-head-tokens", str(policy.prompt_head_tokens),
        "--shared-prefix-replay-tokens", str(policy.shared_prefix_replay_tokens),
        "--max-divergence-tokens", str(policy.max_divergence_tokens),
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--development", required=True)
    parser.add_argument("--pair-receipt", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--token-compute", required=True, type=int)
    parser.add_argument("--max-seq-cap", type=int, default=2048)
    parser.add_argument("--shards", type=int, default=2)
    parser.add_argument("--round", type=int, default=0)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--code-revision", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()

    rows = count_jsonl(pathlib.Path(args.train))
    policy = policy_from_token_compute(
        token_compute=args.token_compute,
        training_rows=rows,
        max_seq_cap=args.max_seq_cap,
    )
    command = build_segment_command(args, policy)
    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "method": "token-compute-to-causal-fork-policy/v1",
        "policy": asdict(policy),
        "delegated_command": command,
        "promotion": "not-admitted",
        "claim_boundary": "Compute allocation and tokenizer-policy transfer only; no gradient or capability claim.",
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if not args.plan_only:
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
