#!/usr/bin/env python3
"""Falsify the impossible version of infinite fixed-state context, then keep the useful part.

The court separates three claims that are often blurred together:

1. Arbitrary exact recall from an unbounded stream cannot be guaranteed by a
   finite resident state. This is a counting statement, not a benchmark claim.
2. O(1) resident state *can* be exact for queries admitting finite sufficient
   statistics (parity/count/modular recurrences are explicit controls here).
3. Exact open-ended recall therefore needs either structure that makes the
   query sufficient-statistic-like, or a memory resource whose distinguishable
   states grow with retained information. ARCHIE's candidate is a two-tier
   system: bounded dynamical state + exact episodic exterior.

This is intentionally hostile to magical "infinite context in one fixed vector
with zero information degradation" language while preserving the architectural
ambition behind it.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import random
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Iterable

SCHEMA = "archie/information-budget-court-v1"


def history_count(alphabet_size: int, length: int) -> int:
    if alphabet_size < 2 or length < 0:
        raise ValueError("alphabet_size>=2 and length>=0 required")
    return alphabet_size ** length


def finite_state_bound(state_bits: int, alphabet_size: int, length: int) -> dict[str, Any]:
    if state_bits < 0:
        raise ValueError("state_bits must be nonnegative")
    states = 1 << state_bits
    histories = history_count(alphabet_size, length)
    return {
        "state_bits": state_bits,
        "distinguishable_states": states,
        "alphabet_size": alphabet_size,
        "history_length": length,
        "possible_histories": histories,
        "lossless_injective_encoding_possible": histories <= states,
        "minimum_bits_for_arbitrary_exact_history": math.ceil(math.log2(histories)) if histories > 1 else 0,
        "pigeonhole_collision_forced": histories > states,
    }


def rolling_compress(symbols: Iterable[int], state_bits: int) -> int:
    """A concrete finite-state compressor used only to produce a collision witness."""
    mask = (1 << state_bits) - 1
    state = 0
    for symbol in symbols:
        # Deliberately simple deterministic recurrence. The general impossibility
        # comes from finite_state_bound, not from weakness of this recurrence.
        state = ((state * 1315423911) ^ (symbol + 0x9E3779B9)) & mask
    return state


def collision_witness(state_bits: int, length: int) -> dict[str, Any]:
    if state_bits > 16:
        raise ValueError("collision witness enumeration is bounded to <=16 bits")
    seen: dict[int, tuple[int, ...]] = {}
    for seq in itertools.product((0, 1), repeat=length):
        state = rolling_compress(seq, state_bits)
        previous = seen.get(state)
        if previous is not None and previous != seq:
            # Pick an exact-recall query on a position where the histories differ.
            differing = next(i for i, (a, b) in enumerate(zip(previous, seq)) if a != b)
            return {
                "found": True,
                "state": state,
                "history_a": list(previous),
                "history_b": list(seq),
                "same_resident_state": True,
                "distinguishing_query": {"type": "symbol_at", "index": differing},
                "answer_a": previous[differing],
                "answer_b": seq[differing],
            }
        seen[state] = seq
    return {"found": False}


def sufficient_statistic_court(seed: int, steps: int) -> dict[str, Any]:
    rng = random.Random(seed)
    parity = 0
    ones_mod_17 = 0
    weighted_mod_257 = 0
    stream: list[int] = []
    for i in range(steps):
        bit = rng.randrange(2)
        stream.append(bit)
        parity ^= bit
        ones_mod_17 = (ones_mod_17 + bit) % 17
        weighted_mod_257 = (weighted_mod_257 + (i + 1) * bit) % 257
    direct = {
        "parity": sum(stream) % 2,
        "ones_mod_17": sum(stream) % 17,
        "weighted_mod_257": sum((i + 1) * bit for i, bit in enumerate(stream)) % 257,
    }
    resident = {
        "parity": parity,
        "ones_mod_17": ones_mod_17,
        "weighted_mod_257": weighted_mod_257,
    }
    return {
        "steps": steps,
        "resident_integer_cells": 3,
        "direct": direct,
        "resident": resident,
        "exact": direct == resident,
        "interpretation": "Fixed resident state is exact when the requested history property has a finite sufficient statistic.",
    }


@dataclass
class BoundedLRU:
    capacity: int

    def __post_init__(self) -> None:
        self.data: OrderedDict[int, int] = OrderedDict()

    def put(self, key: int, value: int) -> None:
        if key in self.data:
            self.data.move_to_end(key)
        self.data[key] = value
        while len(self.data) > self.capacity:
            self.data.popitem(last=False)

    def get(self, key: int) -> int | None:
        value = self.data.get(key)
        if value is not None:
            self.data.move_to_end(key)
        return value


def episodic_exterior_court(seed: int, facts: int, resident_capacity: int) -> dict[str, Any]:
    if not 0 < resident_capacity < facts:
        raise ValueError("require 0 < resident_capacity < facts")
    rng = random.Random(seed)
    resident = BoundedLRU(resident_capacity)
    exterior: dict[int, int] = {}
    for key in range(facts):
        value = rng.getrandbits(31)
        resident.put(key, value)
        exterior[key] = value

    resident_correct = 0
    exterior_correct = 0
    for key in range(facts):
        truth = exterior[key]
        if resident.get(key) == truth:
            resident_correct += 1
        if exterior.get(key) == truth:
            exterior_correct += 1
    return {
        "facts": facts,
        "resident_capacity": resident_capacity,
        "resident_exact_recall": resident_correct,
        "resident_exact_recall_rate": resident_correct / facts,
        "exterior_exact_recall": exterior_correct,
        "exterior_exact_recall_rate": exterior_correct / facts,
        "exterior_entries": len(exterior),
        "interpretation": (
            "The bounded resident cache stays small but cannot retain arbitrary exact facts. "
            "The exact episodic exterior succeeds because its distinguishable storage grows with retained information."
        ),
    }


def run_court(*, state_bits: int, length: int, steps: int, facts: int, resident_capacity: int, seed: int) -> dict[str, Any]:
    bound = finite_state_bound(state_bits, 2, length)
    witness = collision_witness(state_bits, length)
    sufficient = sufficient_statistic_court(seed, steps)
    exterior = episodic_exterior_court(seed ^ 0xA5A5, facts, resident_capacity)
    passed = bool(
        bound["pigeonhole_collision_forced"]
        and witness["found"]
        and witness["answer_a"] != witness["answer_b"]
        and sufficient["exact"]
        and exterior["resident_exact_recall_rate"] < 1.0
        and exterior["exterior_exact_recall_rate"] == 1.0
    )
    return {
        "schema": SCHEMA,
        "pass": passed,
        "arbitrary_history_bound": bound,
        "concrete_collision_witness": witness,
        "finite_sufficient_statistic_control": sufficient,
        "two_tier_memory_control": exterior,
        "architectural_consequence": {
            "resident": "bounded predictive dynamical state / sufficient statistics",
            "exterior": "exact content-addressed episodic memory whose capacity may grow",
            "routing": "surprise/relevance decides what is consolidated, retrieved, or left external",
            "decoder": "language is a projection from state+retrieved evidence, not the memory substrate",
        },
        "claim_boundary": (
            "The counting argument rules out lossless encoding of every arbitrary unbounded history into finite discrete state. "
            "It does not rule out constant-memory solutions for structured tasks, lossy predictive compression, external memory, "
            "or physical systems with a growing/continuous distinguishable state resource."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bits", type=int, default=8)
    parser.add_argument("--history-length", type=int, default=10)
    parser.add_argument("--steps", type=int, default=100_000)
    parser.add_argument("--facts", type=int, default=4096)
    parser.add_argument("--resident-capacity", type=int, default=64)
    parser.add_argument("--seed", type=int, default=5601)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(
        state_bits=args.state_bits,
        length=args.history_length,
        steps=args.steps,
        facts=args.facts,
        resident_capacity=args.resident_capacity,
        seed=args.seed,
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        from pathlib import Path
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
