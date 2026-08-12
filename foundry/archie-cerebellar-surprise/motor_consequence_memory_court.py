#!/usr/bin/env python3
"""Chronological motor-consequence memory comparison.

This court replays ARCHIE's existing reversible motor-babbling world and asks a
hardware-efficiency question before adding resident state: before the current
action executes, how much dynamic history is actually needed to predict the
magnitude of its observed consequence?

Four contenders share the same ridge-linear readout and current motor primitive:
  * action-only: zero dynamic history scalars,
  * one-pole EMA: one scalar, decay selected on validation only,
  * two-pole EMA: two scalars, pole pair selected on validation only,
  * state-dependent nonlinear pair: two scalars, same pole-pair search plus the
    fixed pulse-history nonlinearity from the prior representational court.

Chronological test rows are untouched during pole selection. A valid experiment
is allowed to falsify every memory candidate. No result here promotes resident
state; it only chooses the smallest follow-up worth testing on action value.
"""
from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import math
from pathlib import Path
import sys
import tempfile
from typing import Any, Callable, Iterable, Sequence


SCHEMA = "archie/cerebellar-motor-consequence-memory-court-v2"
ACTION_KINDS = ("append", "mkdir", "rename", "rmdir", "unlink", "write")
DECAYS = (0.10, 0.30, 0.50, 0.70, 0.85, 0.95)
RIDGE = 1e-6
DEFAULT_SEEDS = (56, 5601, 20260811, 23, 101, 313, 809, 1597)

State = tuple[float, ...]
Updater = Callable[[State, float, tuple[float, ...]], State]


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
    byte_term = math.log1p(abs(float(d["byte_delta"]))) / math.log(65.0)
    return min(1.0, 0.5 * structural + 0.5 * min(1.0, byte_term))


def one_hot(kind: str) -> list[float]:
    return [1.0 if kind == candidate else 0.0 for candidate in ACTION_KINDS]


def linear_update(state: State, pulse: float, decays: tuple[float, ...]) -> State:
    return tuple(decay * previous + pulse for previous, decay in zip(state, decays))


def nonlinear_update(state: State, pulse: float, decays: tuple[float, ...]) -> State:
    out = []
    for previous, decay in zip(state, decays):
        pre = decay * previous
        remaining = 1.0 - pre / 2.0
        value = pre + 0.5 * pulse * (remaining ** 2)
        if not math.isfinite(value):
            raise FloatingPointError("nonlinear memory became non-finite")
        out.append(value)
    return tuple(out)


def design(
    rows: Sequence[dict[str, Any]],
    *,
    decays: tuple[float, ...] | None,
    updater: Updater | None,
) -> tuple[list[list[float]], list[float], list[State]]:
    width = 0 if updater is None else len(decays or ())
    if updater is not None and width < 1:
        raise ValueError("dynamic design requires at least one decay")
    state: State = tuple(0.0 for _ in range(width))
    x: list[list[float]] = []
    y: list[float] = []
    states: list[State] = []
    for row in rows:
        kind = str(row.get("motor_action", {}).get("kind", ""))
        base = [1.0, *one_hot(kind)]
        x.append(base if updater is None else [*base, *state])
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
    for i in range(1, p):
        a[i][i] += ridge
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
            if factor:
                aug[row] = [v - factor * w for v, w in zip(aug[row], aug[col])]
    return [aug[i][-1] for i in range(p)]


def predict(x: Sequence[Sequence[float]], weights: Sequence[float]) -> list[float]:
    return [sum(a * b for a, b in zip(row, weights)) for row in x]


def mse(prediction: Sequence[float], target: Sequence[float]) -> float:
    if not prediction or len(prediction) != len(target):
        raise ValueError("invalid MSE inputs")
    return sum((a - b) ** 2 for a, b in zip(prediction, target)) / len(target)


def decay_choices(width: int) -> Iterable[tuple[float, ...]]:
    if width == 1:
        return ((decay,) for decay in DECAYS)
    if width == 2:
        return itertools.combinations(DECAYS, 2)
    raise ValueError("court supports one or two dynamic states")


def fit_selected(rows: Sequence[dict[str, Any]], updater: Updater, *, width: int) -> dict[str, Any]:
    n = len(rows)
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)
    if train_end < 10 or val_end <= train_end or val_end >= n:
        raise ValueError("bad chronological split")
    candidates = []
    for decays in decay_choices(width):
        x, y, _ = design(rows, decays=decays, updater=updater)
        weights = solve_ridge(x[:train_end], y[:train_end])
        validation = mse(predict(x[train_end:val_end], weights), y[train_end:val_end])
        candidates.append((validation, decays))
    candidates.sort(key=lambda item: (item[0], item[1]))
    selected_validation, selected = candidates[0]
    x, y, states = design(rows, decays=selected, updater=updater)
    weights = solve_ridge(x[:val_end], y[:val_end])
    return {
        "state_scalars": width,
        "selected_decays": list(selected),
        "selection_validation_mse": selected_validation,
        "test_mse": mse(predict(x[val_end:], weights), y[val_end:]),
        "max_abs_state": max((abs(value) for state in states for value in state), default=0.0),
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
        "state_scalars": 0,
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
        one = fit_selected(rows, linear_update, width=1)
        two = fit_selected(rows, linear_update, width=2)
        nonlinear = fit_selected(rows, nonlinear_update, width=2)
        replay = fit_selected(rows, nonlinear_update, width=2)
        return {
            "seed": seed,
            "steps": steps,
            "ledger_sha256": motor_receipt["ledger_sha256"],
            "motor_inverse_pass_rate": motor_receipt["inverse_pass_rate"],
            "motor_continuity_pass_rate": motor_receipt["continuity_pass_rate"],
            "action_only": action_only,
            "linear_one_pole": one,
            "linear_two_pole": two,
            "nonlinear_two_state": nonlinear,
            "one_pole_beats_action_only": one["test_mse"] < action_only["test_mse"],
            "two_pole_beats_one_pole": two["test_mse"] < one["test_mse"],
            "nonlinear_beats_two_pole": nonlinear["test_mse"] < two["test_mse"],
            "deterministic_replay_exact": json.dumps(nonlinear, sort_keys=True) == json.dumps(replay, sort_keys=True),
        }


def mean_metric(runs: Sequence[dict[str, Any]], arm: str) -> float:
    return sum(float(run[arm]["test_mse"]) for run in runs) / len(runs)


def run_court(*, seeds: Sequence[int] = DEFAULT_SEEDS, steps: int = 192) -> dict[str, Any]:
    runs = [run_seed(seed, steps) for seed in seeds]
    n = len(runs)
    majority = n // 2 + 1
    action_mean = mean_metric(runs, "action_only")
    one_mean = mean_metric(runs, "linear_one_pole")
    two_mean = mean_metric(runs, "linear_two_pole")
    nonlinear_mean = mean_metric(runs, "nonlinear_two_state")
    one_wins_action = sum(bool(run["one_pole_beats_action_only"]) for run in runs)
    two_wins_one = sum(bool(run["two_pole_beats_one_pole"]) for run in runs)
    nonlinear_wins_two = sum(bool(run["nonlinear_beats_two_pole"]) for run in runs)
    one_gain = (action_mean - one_mean) / max(action_mean, 1e-12)
    second_pole_gain = (one_mean - two_mean) / max(one_mean, 1e-12)
    nonlinear_gain = (two_mean - nonlinear_mean) / max(two_mean, 1e-12)

    one_pole_earns_state = one_wins_action >= majority and one_gain >= 0.01
    second_pole_earns_state = two_wins_one >= majority and second_pole_gain >= 0.01
    nonlinear_earns_followup = nonlinear_wins_two >= majority and nonlinear_gain >= 0.01
    if second_pole_earns_state:
        minimal_followup = "linear-two-pole"
    elif one_pole_earns_state:
        minimal_followup = "linear-one-pole"
    else:
        minimal_followup = "action-only"

    result = {
        "schema": SCHEMA,
        "seeds": list(seeds),
        "steps_per_seed": steps,
        "dynamic_state_scalars": {
            "action_only": 0,
            "linear_one_pole": 1,
            "linear_two_pole": 2,
            "nonlinear_two_state": 2,
        },
        "selection_protocol": (
            "70% chronological train / 15% chronological validation for decay selection / "
            "refit through 85% / final 15% untouched test; >=1% aggregate gain plus strict seed majority "
            "required before paying for additional dynamic state"
        ),
        "target": (
            "bounded observed consequence magnitude from topology edits and absolute byte delta; "
            "current motor primitive one-hot is available to every readout"
        ),
        "runs": runs,
        "aggregate": {
            "action_only_mean_test_mse": action_mean,
            "linear_one_pole_mean_test_mse": one_mean,
            "linear_two_pole_mean_test_mse": two_mean,
            "nonlinear_two_state_mean_test_mse": nonlinear_mean,
            "one_pole_seed_wins_vs_action_only": one_wins_action,
            "two_pole_seed_wins_vs_one_pole": two_wins_one,
            "nonlinear_seed_wins_vs_two_pole": nonlinear_wins_two,
            "one_pole_relative_improvement_vs_action_only": one_gain,
            "second_pole_relative_improvement_vs_one_pole": second_pole_gain,
            "nonlinear_relative_improvement_vs_two_pole": nonlinear_gain,
            "one_pole_earns_state": one_pole_earns_state,
            "second_pole_earns_state": second_pole_earns_state,
            "nonlinear_earns_followup": nonlinear_earns_followup,
            "minimal_followup": minimal_followup,
        },
        "checks": {
            "all_motor_inverse_courts_exact": all(run["motor_inverse_pass_rate"] == 1.0 for run in runs),
            "all_motor_continuity_courts_exact": all(run["motor_continuity_pass_rate"] == 1.0 for run in runs),
            "all_metrics_finite": all(
                math.isfinite(float(run[arm]["test_mse"]))
                for run in runs
                for arm in ("action_only", "linear_one_pole", "linear_two_pole", "nonlinear_two_state")
            ),
            "all_nonlinear_replays_exact": all(run["deterministic_replay_exact"] for run in runs),
            "state_counts_are_explicit": True,
        },
        "court_valid": False,
        "promotion": False,
        "interpretation": "",
    }
    result["court_valid"] = all(bool(value) for value in result["checks"].values())
    result["interpretation"] = (
        f"Natural consequence replay selects {minimal_followup} as the smallest follow-up under the predeclared "
        "1%-plus-majority state-cost rule. Nonlinear history remains unpromoted. This predicts consequence magnitude, "
        "not utility; any resident integration still requires a counterfactual action-value/progress court."
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=192)
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
