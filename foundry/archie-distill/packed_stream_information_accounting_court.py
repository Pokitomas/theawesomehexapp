#!/usr/bin/env python3
"""Separate PyTorch token presentations from unique corpus evidence.

packed_stream_train.py advances `tokens_seen` by BATCH*SEQ for every optimizer
step. That is exact compute/presentation accounting for an input tensor of
shape [BATCH, SEQ]. The corpus sampler, however, enumerates every overlapping
length-SEQ window start. Across one complete sampler period, target positions
are therefore reused many times.

This court makes the distinction executable. It does not say overlapping
windows are bad; it says a tensor-element count and an information-acquisition
count are different mathematical objects and must not silently share a name in
scaling/developmental claims.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def choose_stride(window_count: int, initial: int = 4099) -> int:
    stride = initial
    while math.gcd(stride, window_count) != 1:
        stride += 2
    return stride


def enumerate_period(corpus_tokens: int, seq: int, origin: int = 123456) -> dict[str, Any]:
    if seq < 1:
        raise ValueError("seq must be positive")
    if corpus_tokens <= seq + 1:
        raise ValueError("corpus must contain more than seq+1 tokens")

    window_count = corpus_tokens - seq
    origin %= window_count
    stride = choose_stride(window_count)
    starts = [(origin + i * stride) % window_count for i in range(window_count)]

    target_multiplicity = [0] * corpus_tokens
    for start in starts:
        for j in range(1, seq + 1):
            target_multiplicity[start + j] += 1

    target_presentations = window_count * seq
    unique_target_positions = sum(x > 0 for x in target_multiplicity)
    positive = [x for x in target_multiplicity if x > 0]
    mean_reuse = target_presentations / unique_target_positions

    # Closed form for this non-circular sliding-window geometry.
    expected_unique = corpus_tokens - 1
    expected_presentations = (corpus_tokens - seq) * seq

    return {
        "corpus_tokens": corpus_tokens,
        "sequence_length": seq,
        "window_count": window_count,
        "origin": origin,
        "stride": stride,
        "unique_start_count": len(set(starts)),
        "target_presentations_per_sampler_period": target_presentations,
        "unique_target_positions_per_sampler_period": unique_target_positions,
        "mean_target_position_reuse": mean_reuse,
        "min_positive_target_multiplicity": min(positive),
        "max_target_multiplicity": max(positive),
        "closed_form_unique_target_positions": expected_unique,
        "closed_form_target_presentations": expected_presentations,
        "presentation_to_unique_ratio": target_presentations / expected_unique,
        "permutation_is_full_period": len(set(starts)) == window_count,
        "closed_form_matches_enumeration": (
            unique_target_positions == expected_unique
            and target_presentations == expected_presentations
        ),
    }


def run_court(corpus_tokens: int, seq: int) -> dict[str, Any]:
    main = enumerate_period(corpus_tokens, seq)
    controls = [
        enumerate_period(257, 8),
        enumerate_period(1021, 32),
        enumerate_period(4099, 64),
    ]
    passed = bool(
        main["permutation_is_full_period"]
        and main["closed_form_matches_enumeration"]
        and main["unique_target_positions_per_sampler_period"] == corpus_tokens - 1
        and main["presentation_to_unique_ratio"] > 1.0
        and all(c["permutation_is_full_period"] and c["closed_form_matches_enumeration"] for c in controls)
    )
    return {
        "schema": "archie-distill/packed-stream-information-accounting-court-v1",
        "pass": passed,
        "main": main,
        "controls": controls,
        "tensor_semantics": (
            "BATCH*SEQ counts target tensor presentations consumed by optimizer steps. "
            "It is a compute/exposure coordinate, not the cardinality of distinct corpus target positions acquired."
        ),
        "mathematical_identity": (
            "For N corpus tokens and overlapping length-S windows over every valid start, one sampler period contains "
            "(N-S)*S target presentations but only N-1 distinct target positions."
        ),
        "architectural_pressure": (
            "Keep presentation tokens, unique evidence coverage, and optimizer steps as separate receipt coordinates. "
            "Any scaling law or developmental controller must declare which coordinate it consumes."
        ),
        "claim_boundary": (
            "PASS does not falsify overlapping-window training or claim statistical independence of token positions. "
            "It only falsifies treating the tensor-presentation counter as a unique-information counter."
        ),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--corpus-tokens", type=int, default=100_003)
    p.add_argument("--seq", type=int, default=1024)
    p.add_argument("--output")
    args = p.parse_args()
    result = run_court(args.corpus_tokens, args.seq)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        out = Path(args.output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
