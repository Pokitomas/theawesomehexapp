#!/usr/bin/env python3
"""Chronological motor-consequence memory comparison.

This is the first paper-inspired court that does not manufacture a label from a
known null space.  It replays ARCHIE's existing reversible motor-babbling world
and asks a modest practical question: before the current action executes, does
a two-scalar history state improve prediction of the *magnitude of the observed
consequence* beyond the action primitive alone?

Three contenders share one linear readout:
  * action-only: no dynamic history state,
  * learned two-pole EMA: two scalar states, poles selected on validation only,
  * state-dependent nonlinear pair: two scalar states, the same pole search,
    fixed pulse-history nonlinearity from the prior representational court.

The target is derived only from observed consequences (object graph edits and
absolute byte change).  Chronological test rows are never used to select poles.
A valid experiment is allowed to report that the nonlinear candidate loses.
No result in this file promotes resident state.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile
from typing import Any, Callable, Iterable, Sequence


SCHEMA = "archie/cerebellar-motor-consequence-memory-court-v1"
ACTION_KINDS = ("append", "mkdir", "rename", "rmdir", "unlink", "write")
DECAYS = (0.10, 0.30, 0.50, 0.70, 0.85, 0.95)
RIDGE = 1e-6


def load_motor():
    path = Path(__file__).resolve().parents[1] / "archie-action-latent" / "motor_babble.py"
    spec = importlib.util.spec_from_file_location("archie_motor_babble_for_consequence_memory", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]
    if len(rows) < 30:
        raise ValueError("motor ledger too small for chronological court")
    return rows


def consequence_magnitude(row: dict[str, Any]) -> float:
    d = row["observed_delta"]
    structural = sum(
        abs(float(d[name]))
        for name in (
            "created_files",
            "created_dirs",
            "deleted_files",
            "deleted_dirs",
            "changed_files",
        )
    )
    # Random motor payloads are 1..64 chars. Rewrites may move across that
    # range, so log compression prevents byte magnitude from dwarfing topology.
    byte_term = math.log1p(abs(float(d["byte_delta"]))) / math.log(65.0)
    return min(1.0, 0.5 * structural + 0.5 * min(1.0, byte_term))


def one_hot(kind: str) -> list[float]:
    return [1.0 if kind == candidate else 0.0 for candidate in ACTION_KINDS]


def linear_update(state: tuple[float, float], pulse: float, decays: tuple[float, float]) -> tuple[float, float]:
    return (
        decays[0] * state[0] + pulse,
        decays[1] * state[1] + pulse,
    )


def nonlinear_update(state: tuple[float, float], pulse: float, decays: tuple[float, float]) -> tuple[float, float]:
    out = []
    for previous, decay in zip(state, decays):
        pre = decay * previous
        remaining = 1.0 - pre / 2.0
        value = pre + 0.5 * pulse * (remaining ** 2)
        if not math.isfinite(value):
            raise FloatingPointError("nonlinear memory became non-finite")
        out.append(value)
    return out[0], out[1]


def design(
    rows: Sequence[dict[str, Any]],
    *,
    decays: tuple[float, float] | None,
    updater: Callable[[tuple[float, float], float, tuple[float, float]], tuple[float, float]] | None,
) -> tuple[list[list[float]], list[float], list[tuple[float, float]]]:
    state = (0.0, 0.0)
    x: list[list[float]] = []
    y: list[float] = []
    states: list[tuple[float, float]] = []
    for row in rows:
        kind = str(row.get("motor_action", {}).get("kind", ""))
        base = [1.0, *one_hot(kind)]
        x.append(base if updater is None else [*base, state[0], state[1]])
        pulse = consequence_magnitude(row)
        y.append(pulse)
        states.append(state)
        if updater is not None:
            assert decays is not None
            state = updater(state, pulse, decays)
    return x, y, states


def solve_ridge(x: Sequence[Sequence[float]], y: Sequence[float], ridge: float = RIDGE) -> list[float]:
    if not x or len(x) != len(y):
        raise ValueError("invalid regression rows")
    p = len(x[0])
    a = [[0.0 for _ in range(p)] for _ in range(p)]
    b = [0.0 for _ in range(p)]
    for row, target in zip(x, y):
        if len(row) != p:
            raise ValueError("ragged design")
        for i in range(p):
            b[i] += row[i] * target
            for j in range(p):
                a[i][j] += row[i] * row[j]
    for i in range(1, p):  # do not regularize intercept
        a[i][i] += ridge

    # Small dense Gaussian elimination with partial pivoting. Keeping this court
    # dependency-free makes it executable on the same CPU-only CI as motor babble.
    aug = [a[i] + [b[i]] for i in range(p)]
    for col in range(p):
        pivot = max(range(col, p), key=lambda row: abs(aug[row][col]))
        if abs(aug[pivot][col]) < 1e-12:
            aug[pivot][col] += 1e-9
        aug[col], aug[pivot] = aug[pivot], aug[col]
        scale = aug[col][col]
        aug[col] = [value / scale for value in aug[col]]
        for row in range(p):
            if row == col:
                continue
            factor = aug[row][col]
            if factor == 0.0:
                continue
            aug[row] = [v - factor * w for v, w in zip(aug[row], aug[col])]
    return [aug[i][-1] for i in range(p)]


def predict(x: Sequence[Sequence[float]], weights: Sequence[float]) -> list[float]:
    return [sum(a * b for a, b in zip(row, weights)) for row in x]


def mse(prediction: Sequence[float], target: Sequence[float]) -> float:
    if not prediction or len(prediction) != len(target):
        raise ValueError("invalid MSE inputs")
    return sum((a - b) ** 2 for a, b in zip(prediction, target)) / len(target)


def decay_pairs() -> Iterable[tuple[float, float]]:
    for i, first in enumerate(DECAYS):
        for second in DECAYS[i + 1 :]:
            yield first, second


def fit_selected(
    rows: Sequence[dict[str, Any]],
    updater: Callable[[tuple[float, float], float, tuple[float, float]], tuple[float, float]],
) -> dict[str, Any]:
    n = len(rows)
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)
    if train_end < 10 or val_end <= train_end or val_end >= n:
        raise ValueError("bad chronological split")

    candidates = []
    for decays in decay_pairs():
        x, y, states = design(rows, decays=decays, updater=updater)
        weights = solve_ridge(x[:train_end], y[:train_end])
        val_mse = mse(predict(x[train_end:val_end], weights), y[train_end:val_end])
        candidates.append((val_mse, decays, states))
    candidates.sort(key=lambda item: (item[0], item[1]))
    selected_val_mse, selected, _ = candidates[0]

    x, y, states = design(rows, decays=selected, updater=updater)
    weights = solve_ridge(x[:val_end], y[:val_end])
    test_mse = mse(predict(x[val_end:], weights), y[val_end:])
    max_abs_state = max(abs(value) for state in states for value in state)
    return {
        "selected_decays": list(selected),
        "selection_validation_mse": selected_val_mse,
        "test_mse": test_mse,
        "max_abs_state": max_abs_state,
        "weights": weights,
        "train_end": train_end,
        "validation_end": val_end,
        "test_rows": n - val_end,
    }


def fit_action_only(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    val_end = int(n * 0.85)
    x, y, _ = design(rows, decays=None, updater=None)
    weights = solve_ridge(x[:val_end], y[:val_end])
    return {
        "test_mse": mse(predict(x[val_end:], weights), y[val_end:]),
        "weights": weights,
        "test_rows": n - val_end,
    }


def run_seed(seed: int, steps: int) -> dict[str, Any]:
    motor = load_motor()
    with tempfile.TemporaryDirectory(prefix=f"archie-natural-consequence-s{seed}-") as td:
        root = Path(td) / "world"
        ledger = Path(td) / "motor.jsonl"
        motor_receipt = motor.run_court(root, ledger, steps, seed)
        rows = load_rows(ledger)
        action_only = fit_action_only(rows)
        linear = fit_selected(rows, linear_update)
        nonlinear = fit_selected(rows, nonlinear_update)
        replay_nonlinear = fit_selected(rows, nonlinear_update)
        deterministic = json.dumps(nonlinear, sort_keys=True) == json.dumps(replay_nonlinear, sort_keys=True)
        return {
            "seed": seed,
            "steps": steps,
            "ledger_sha256": motor_receipt["ledger_sha256"],
            "motor_inverse_pass_rate": motor_receipt["inverse_pass_rate"],
            "motor_continuity_pass_rate": motor_receipt["continuity_pass_rate"],
            "action_only": action_only,
            "linear_two_pole": linear,
            "nonlinear_two_state": nonlinear,
            "nonlinear_beats_linear": nonlinear["test_mse"] < linear["test_mse"],
            "nonlinear_beats_action_only": nonlinear["test_mse"] < action_only["test_mse"],
            "deterministic_replay_exact": deterministic,
        }


def run_court(*, seeds: Sequence[int] = (56, 5601, 20260811), steps: int = 256) -> dict[str, Any]:
    runs = [run_seed(seed, steps) for seed in seeds]
    linear_mean = sum(run["linear_two_pole"]["test_mse"] for run in runs) / len(runs)
    nonlinear_mean = sum(run["nonlinear_two_state"]["test_mse"] for run in runs) / len(runs)
    action_only_mean = sum(run["action_only"]["test_mse"] for run in runs) / len(runs)
    nonlinear_wins = sum(bool(run["nonlinear_beats_linear"]) for run in runs)
    relative = (linear_mean - nonlinear_mean) / max(linear_mean, 1e-12)
    candidate_earns_followup = nonlinear_wins >= 2 and relative >= 0.01

    result = {
        "schema": SCHEMA,
        "seeds": list(seeds),
        "steps_per_seed": steps,
        "dynamic_state_scalars": {"action_only": 0, "linear_two_pole": 2, "nonlinear_two_state": 2},
        "selection_protocol": (
            "70% chronological train / 15% chronological validation for pole selection / "
            "refit through 85% / final 15% untouched test"
        ),
        "target": (
            "bounded observed consequence magnitude from topology edits and absolute byte delta; "
            "current motor primitive one-hot is available to every readout"
        ),
        "runs": runs,
        "aggregate": {
            "action_only_mean_test_mse": action_only_mean,
            "linear_two_pole_mean_test_mse": linear_mean,
            "nonlinear_two_state_mean_test_mse": nonlinear_mean,
            "nonlinear_seed_wins_vs_linear": nonlinear_wins,
            "nonlinear_relative_improvement_vs_linear": relative,
            "candidate_earns_followup": candidate_earns_followup,
        },
        "checks": {
            "all_motor_inverse_courts_exact": all(run["motor_inverse_pass_rate"] == 1.0 for run in runs),
            "all_motor_continuity_courts_exact": all(run["motor_continuity_pass_rate"] == 1.0 for run in runs),
            "all_metrics_finite": all(
                math.isfinite(value)
                for run in runs
                for value in (
                    run["action_only"]["test_mse"],
                    run["linear_two_pole"]["test_mse"],
                    run["nonlinear_two_state"]["test_mse"],
                    run["nonlinear_two_state"]["max_abs_state"],
                )
            ),
            "all_nonlinear_replays_exact": all(run["deterministic_replay_exact"] for run in runs),
            "matched_dynamic_state_count": True,
        },
        "court_valid": False,
        "promotion": False,
        "interpretation": "",
    }
    result["court_valid"] = all(bool(value) for value in result["checks"].values())
    if candidate_earns_followup:
        result["interpretation"] = (
            "The fixed state-dependent two-state memory beat the validation-selected two-pole EMA on at least two "
            "of three natural motor-babble streams by >=1% aggregate test MSE. This earns a larger learned-baseline "
            "follow-up only; it does not earn resident promotion or establish action value."
        )
    else:
        result["interpretation"] = (
            "The state-dependent two-state memory did not clear the predeclared natural motor-consequence threshold. "
            "Keep it out of the resident; the earlier null-space/action construction remains an adversarial existence "
            "proof rather than evidence of practical superiority."
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=256)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(steps=args.steps)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
    print(text)
    raise SystemExit(0 if result["court_valid"] else 1)


if __name__ == "__main__":
    main()
