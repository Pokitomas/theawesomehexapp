#!/usr/bin/env python3
"""Bounded online memory for a resident action/world state.

This is a developmental mechanism, not an intelligence claim.  It combines a
short-lived fast matrix with a slowly consolidated matrix.  Prediction error
("surprise") gates fast writes; only comparatively familiar states consolidate
into the slow store.  Abrupt shifts therefore alter the labile state first
instead of immediately overwriting the persistent state.

The design is intentionally small and inspectable.  It borrows broad ideas
from test-time/fast-weight memory, differentiable neuromodulated plasticity,
and multi-timescale synaptic consolidation, but implements its own bounded
online rule with no language or command labels.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

Vector = list[float]
Matrix = list[list[float]]


def _zeros(dim: int) -> Matrix:
    return [[0.0 for _ in range(dim)] for _ in range(dim)]


def _matvec(matrix: Matrix, vector: Sequence[float]) -> Vector:
    return [sum(weight * value for weight, value in zip(row, vector)) for row in matrix]


def _matrix_norm(matrix: Matrix) -> float:
    return math.sqrt(sum(value * value for row in matrix for value in row))


def _clip_matrix_norm(matrix: Matrix, limit: float) -> None:
    norm = _matrix_norm(matrix)
    if norm <= limit or norm == 0.0:
        return
    scale = limit / norm
    for row in matrix:
        for index in range(len(row)):
            row[index] *= scale


def _rms(vector: Sequence[float]) -> float:
    return math.sqrt(sum(value * value for value in vector) / max(1, len(vector)))


def _finite_matrix(matrix: Matrix) -> bool:
    return all(math.isfinite(value) for row in matrix for value in row)


@dataclass(frozen=True)
class MemoryConfig:
    dim: int
    fast_learning_rate: float = 0.35
    slow_consolidation_rate: float = 0.01
    fast_decay: float = 0.02
    surprise_target: float = 0.05
    surprise_ema_rate: float = 0.05
    max_fast_norm: float = 4.0
    max_slow_norm: float = 8.0

    def validate(self) -> None:
        if self.dim <= 0:
            raise ValueError("dim must be positive")
        for name in (
            "fast_learning_rate",
            "slow_consolidation_rate",
            "fast_decay",
            "surprise_target",
            "surprise_ema_rate",
            "max_fast_norm",
            "max_slow_norm",
        ):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value < 0.0:
                raise ValueError(f"{name} must be finite and non-negative")
        if self.fast_decay >= 1.0:
            raise ValueError("fast_decay must be < 1")
        if not 0.0 < self.surprise_ema_rate <= 1.0:
            raise ValueError("surprise_ema_rate must be in (0, 1]")
        if self.max_fast_norm <= 0.0 or self.max_slow_norm <= 0.0:
            raise ValueError("memory norm limits must be positive")


class HomeostaticSurpriseMemory:
    """Two-timescale consequence memory with bounded surprise-gated plasticity."""

    SCHEMA = "archie/homeostatic-surprise-memory-v1"

    def __init__(self, config: MemoryConfig):
        config.validate()
        self.config = config
        self.fast = _zeros(config.dim)
        self.slow = _zeros(config.dim)
        self.surprise_ema = config.surprise_target
        self.steps = 0

    def _check_vector(self, vector: Sequence[float], name: str) -> Vector:
        values = [float(value) for value in vector]
        if len(values) != self.config.dim:
            raise ValueError(f"{name} has dim {len(values)}, expected {self.config.dim}")
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"{name} must be finite")
        return values

    def predict(self, key: Sequence[float]) -> Vector:
        x = self._check_vector(key, "key")
        slow = _matvec(self.slow, x)
        fast = _matvec(self.fast, x)
        return [stable + recent for stable, recent in zip(slow, fast)]

    def observe(self, key: Sequence[float], target: Sequence[float]) -> dict[str, float | int]:
        x = self._check_vector(key, "key")
        y = self._check_vector(target, "target")
        prediction = self.predict(x)
        error = [wanted - got for wanted, got in zip(y, prediction)]
        surprise = _rms(error)

        # Compare current surprise with the *previous* running level.  Updating
        # the reference first would let a single shock normalize itself.
        reference = max(self.config.surprise_target, self.surprise_ema)
        novelty = surprise / (surprise + reference + 1e-12)
        novelty = max(0.0, min(1.0, novelty))

        self.surprise_ema = (
            (1.0 - self.config.surprise_ema_rate) * self.surprise_ema
            + self.config.surprise_ema_rate * surprise
        )

        # Normalized delta-rule write.  A huge input vector cannot alone create
        # a huge weight update, and the final norm court is a second boundary.
        key_energy = sum(value * value for value in x) + 1e-6
        for row in range(self.config.dim):
            for column in range(self.config.dim):
                self.fast[row][column] *= 1.0 - self.config.fast_decay
                self.fast[row][column] += (
                    self.config.fast_learning_rate
                    * novelty
                    * error[row]
                    * x[column]
                    / key_energy
                )
        _clip_matrix_norm(self.fast, self.config.max_fast_norm)

        # Consolidation is deliberately asymmetric: novelty gets a fast write,
        # while only lower-than-reference error is allowed to harden the slow
        # state.  This creates a small stability/plasticity separation instead
        # of immediately baking every surprise into persistent memory.
        familiarity = 1.0 - surprise / (reference + 1e-12)
        familiarity = max(0.0, min(1.0, familiarity))
        for row in range(self.config.dim):
            for column in range(self.config.dim):
                self.slow[row][column] += (
                    self.config.slow_consolidation_rate
                    * familiarity
                    * self.fast[row][column]
                )
        _clip_matrix_norm(self.slow, self.config.max_slow_norm)

        self.steps += 1
        return {
            "step": self.steps,
            "surprise": surprise,
            "surprise_ema": self.surprise_ema,
            "novelty_gate": novelty,
            "familiarity_gate": familiarity,
            "fast_norm": _matrix_norm(self.fast),
            "slow_norm": _matrix_norm(self.slow),
        }

    def relax(self, steps: int = 1) -> None:
        """Let labile memory decay without fabricating a training observation."""
        if steps < 0:
            raise ValueError("steps must be non-negative")
        scale = (1.0 - self.config.fast_decay) ** steps
        for row in self.fast:
            for index in range(len(row)):
                row[index] *= scale

    def snapshot(self) -> dict[str, Any]:
        return {
            "schema": self.SCHEMA,
            "config": asdict(self.config),
            "fast": [row[:] for row in self.fast],
            "slow": [row[:] for row in self.slow],
            "surprise_ema": self.surprise_ema,
            "steps": self.steps,
        }

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> "HomeostaticSurpriseMemory":
        if snapshot.get("schema") != cls.SCHEMA:
            raise ValueError("memory snapshot schema mismatch")
        memory = cls(MemoryConfig(**snapshot["config"]))
        dim = memory.config.dim
        for name in ("fast", "slow"):
            matrix = [[float(value) for value in row] for row in snapshot[name]]
            if len(matrix) != dim or any(len(row) != dim for row in matrix):
                raise ValueError(f"{name} matrix shape mismatch")
            if not _finite_matrix(matrix):
                raise ValueError(f"{name} matrix must be finite")
            setattr(memory, name, matrix)
        memory.surprise_ema = float(snapshot["surprise_ema"])
        memory.steps = int(snapshot["steps"])
        if not math.isfinite(memory.surprise_ema) or memory.steps < 0:
            raise ValueError("invalid memory scalar state")
        return memory


def _apply(matrix: Matrix, vector: Sequence[float]) -> Vector:
    return _matvec(matrix, vector)


def run_developmental_court(seed: int = 5602) -> dict[str, Any]:
    rng = random.Random(seed)
    memory = HomeostaticSurpriseMemory(MemoryConfig(dim=2))
    stable_world = [[1.0, 0.25], [-0.15, 0.75]]
    shifted_world = [[0.2, -0.8], [0.85, 0.15]]

    stable_surprise: list[float] = []
    for _ in range(300):
        key = [rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0)]
        receipt = memory.observe(key, _apply(stable_world, key))
        stable_surprise.append(float(receipt["surprise"]))

    shifted_surprise: list[float] = []
    for _ in range(60):
        key = [rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0)]
        receipt = memory.observe(key, _apply(shifted_world, key))
        shifted_surprise.append(float(receipt["surprise"]))

    # A deliberately absurd consequence tests the hard state bound.  We grade
    # boundedness, not whether the outlier is learned.
    shock_receipt = memory.observe([1.0, -1.0], [1_000_000.0, -1_000_000.0])

    snapshot = memory.snapshot()
    restored = HomeostaticSurpriseMemory.from_snapshot(snapshot)
    probe = [0.31, -0.47]
    restore_error = max(
        abs(left - right)
        for left, right in zip(memory.predict(probe), restored.predict(probe))
    )

    result = {
        "schema": "archie/homeostatic-surprise-memory-court-v1",
        "seed": seed,
        "stable_initial_surprise": statistics.fmean(stable_surprise[:20]),
        "stable_final_surprise": statistics.fmean(stable_surprise[-20:]),
        "shift_initial_surprise": statistics.fmean(shifted_surprise[:10]),
        "shift_final_surprise": statistics.fmean(shifted_surprise[-10:]),
        "shock_surprise": shock_receipt["surprise"],
        "fast_norm_after_shock": shock_receipt["fast_norm"],
        "slow_norm_after_shock": shock_receipt["slow_norm"],
        "snapshot_restore_max_abs_error": restore_error,
        "steps": memory.steps,
    }
    result["pass"] = bool(
        result["stable_final_surprise"] < result["stable_initial_surprise"] * 0.55
        and result["shift_final_surprise"] < result["shift_initial_surprise"] * 0.55
        and result["fast_norm_after_shock"] <= memory.config.max_fast_norm + 1e-9
        and result["slow_norm_after_shock"] <= memory.config.max_slow_norm + 1e-9
        and result["snapshot_restore_max_abs_error"] <= 1e-12
        and _finite_matrix(memory.fast)
        and _finite_matrix(memory.slow)
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=5602)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_developmental_court(args.seed)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
