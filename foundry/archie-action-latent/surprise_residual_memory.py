#!/usr/bin/env python3
"""Exact predictive memory with bounded resident dynamics plus sparse residual exterior.

This is a constructive response to the information-budget court. Instead of
pretending an arbitrary infinite stream fits losslessly in fixed state, keep a
small online predictor resident and write only prediction errors to an exact
append-only exterior. Decoder replay is exact because every surprise is stored.

For compressible dynamics the residual exterior can grow much slower than the
stream. For incompressible/random dynamics it correctly degrades toward linear
storage rather than hallucinating forgotten information.
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA = "archie/surprise-residual-memory-v1"


@dataclass
class TransitionPredictor:
    alphabet: int
    counts: dict[int, Counter[int]] = field(default_factory=lambda: defaultdict(Counter))
    global_counts: Counter[int] = field(default_factory=Counter)

    def predict(self, previous: int | None) -> int:
        if previous is not None and self.counts[previous]:
            # Deterministic tie-break preserves decoder equivalence.
            best = max(self.counts[previous].values())
            return min(symbol for symbol, count in self.counts[previous].items() if count == best)
        if self.global_counts:
            best = max(self.global_counts.values())
            return min(symbol for symbol, count in self.global_counts.items() if count == best)
        return 0

    def observe(self, previous: int | None, symbol: int) -> None:
        if not 0 <= symbol < self.alphabet:
            raise ValueError(symbol)
        if previous is not None:
            self.counts[previous][symbol] += 1
        self.global_counts[symbol] += 1


@dataclass
class ResidualRecord:
    index: int
    symbol: int


@dataclass
class EncodedStream:
    alphabet: int
    length: int
    residuals: list[ResidualRecord]

    def public(self) -> dict[str, Any]:
        return {
            "alphabet": self.alphabet,
            "length": self.length,
            "residual_count": len(self.residuals),
            "residual_rate": len(self.residuals) / max(1, self.length),
            "residuals": [{"index": r.index, "symbol": r.symbol} for r in self.residuals],
        }


def encode(stream: list[int], alphabet: int) -> EncodedStream:
    predictor = TransitionPredictor(alphabet)
    previous: int | None = None
    residuals: list[ResidualRecord] = []
    for i, symbol in enumerate(stream):
        prediction = predictor.predict(previous)
        if prediction != symbol:
            residuals.append(ResidualRecord(i, symbol))
        predictor.observe(previous, symbol)
        previous = symbol
    return EncodedStream(alphabet, len(stream), residuals)


def decode(encoded: EncodedStream) -> list[int]:
    predictor = TransitionPredictor(encoded.alphabet)
    residual_map = {record.index: record.symbol for record in encoded.residuals}
    if len(residual_map) != len(encoded.residuals):
        raise ValueError("duplicate residual index")
    previous: int | None = None
    stream: list[int] = []
    for i in range(encoded.length):
        prediction = predictor.predict(previous)
        symbol = residual_map.get(i, prediction)
        predictor.observe(previous, symbol)
        stream.append(symbol)
        previous = symbol
    return stream


def structured_stream(length: int, alphabet: int, seed: int, noise_rate: float) -> list[int]:
    rng = random.Random(seed)
    # A deterministic orbit with sparse perturbations. It is deliberately not
    # language: the primitive is consequence dynamics, not token syntax.
    x = rng.randrange(alphabet)
    out: list[int] = []
    for i in range(length):
        if rng.random() < noise_rate:
            x = rng.randrange(alphabet)
        else:
            x = (3 * x + 1 + (i % 2)) % alphabet
        out.append(x)
    return out


def markov_stream(length: int, alphabet: int, seed: int, deterministic_prob: float) -> list[int]:
    rng = random.Random(seed)
    x = rng.randrange(alphabet)
    out: list[int] = []
    for _ in range(length):
        if rng.random() < deterministic_prob:
            x = (x + 1) % alphabet
        else:
            x = rng.randrange(alphabet)
        out.append(x)
    return out


def random_stream(length: int, alphabet: int, seed: int) -> list[int]:
    rng = random.Random(seed)
    return [rng.randrange(alphabet) for _ in range(length)]


def evaluate(name: str, stream: list[int], alphabet: int) -> dict[str, Any]:
    encoded = encode(stream, alphabet)
    recovered = decode(encoded)
    return {
        "name": name,
        "length": len(stream),
        "residual_count": len(encoded.residuals),
        "residual_rate": len(encoded.residuals) / max(1, len(stream)),
        "exact_replay": recovered == stream,
        "mismatch_count": sum(a != b for a, b in zip(stream, recovered)),
    }


def run_court(length: int, alphabet: int, seed: int) -> dict[str, Any]:
    cases = [
        evaluate("structured_sparse_noise", structured_stream(length, alphabet, seed, 0.01), alphabet),
        evaluate("mostly_deterministic_markov", markov_stream(length, alphabet, seed + 1, 0.98), alphabet),
        evaluate("uniform_random", random_stream(length, alphabet, seed + 2), alphabet),
    ]
    structured = cases[0]
    markov = cases[1]
    random_case = cases[2]
    passed = bool(
        all(case["exact_replay"] for case in cases)
        and structured["residual_rate"] < random_case["residual_rate"]
        and markov["residual_rate"] < random_case["residual_rate"]
        and random_case["residual_rate"] > 0.5
    )
    return {
        "schema": SCHEMA,
        "pass": passed,
        "alphabet": alphabet,
        "length": length,
        "cases": cases,
        "architecture": {
            "resident": "small online consequence predictor",
            "exterior": "append-only exact surprise residuals",
            "decode": "replay resident dynamics and override at residual indices",
            "growth_law": "data-dependent: sparse for predictable streams, linear in worst case",
        },
        "claim_boundary": (
            "Exact replay here is constructive for this predictor/residual codec. It does not imply universal compression below entropy. "
            "The useful result is graceful truthfulness: structured experience can be retained with sparse exact residuals, while random "
            "experience consumes storage instead of being silently collapsed into a finite latent state."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--length", type=int, default=100_000)
    parser.add_argument("--alphabet", type=int, default=16)
    parser.add_argument("--seed", type=int, default=5601)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.length < 100 or args.alphabet < 2:
        raise SystemExit("length>=100 and alphabet>=2 required")
    result = run_court(args.length, args.alphabet, args.seed)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
