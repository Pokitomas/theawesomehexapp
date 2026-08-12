#!/usr/bin/env python3
"""Event-addressed cerebellar-inspired surprise, as a falsification oracle.

This is not a memtransistor/device emulator. It extracts one software motif
from Kang et al., Nature Communications (2026): event-triggered excitatory and
inhibitory traces with different relaxation times. The court deliberately asks
whether that motif earns anything over ordinary filters before ARCHIE is
allowed to use it as an architectural claim.

A key negative theorem is executable here. If a pulse rule is approximated as

    pre = d * previous
    increment = b * (1 - pre / capacity)
    post = pre + increment

then

    post = d * (1 - b / capacity) * previous + b,

which is exactly an affine first-order exponential filter. A paired E/I system
of that restricted form is therefore only a two-pole affine filter bank; two
timescales alone are not software novelty.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
from typing import Hashable, Iterable


SCHEMA = "archie/cerebellar-surprise-reference-v1"


@dataclass(frozen=True)
class TraceConfig:
    tau_e: float = 8.0
    tau_i: float = 2.0
    increment_e: float = 0.35
    increment_i: float = 0.80
    nominal_gap: int = 1

    def validate(self) -> None:
        if not self.tau_e > self.tau_i > 0.0:
            raise ValueError("require tau_e > tau_i > 0")
        if not self.increment_i > self.increment_e > 0.0:
            raise ValueError("require increment_i > increment_e > 0")
        if self.nominal_gap <= 0:
            raise ValueError("nominal_gap must be positive")

    def alpha_e(self, gap: int | float | None = None) -> float:
        g = self.nominal_gap if gap is None else gap
        return math.exp(-float(g) / self.tau_e)

    def alpha_i(self, gap: int | float | None = None) -> float:
        g = self.nominal_gap if gap is None else gap
        return math.exp(-float(g) / self.tau_i)

    def initial_novelty(self) -> float:
        return self.increment_i - self.increment_e

    def steady_novelty(self) -> float:
        ae, ai = self.alpha_e(), self.alpha_i()
        e_ss = self.increment_e / (1.0 - ae)
        i_ss = self.increment_i / (1.0 - ai)
        return i_ss - e_ss

    def supports_one_event_then_habituation(self) -> bool:
        # x[n] = a*x[n-1]+b has x_ss=b/(1-a). We want I-E positive
        # on the first event but non-positive after a familiar steady regime.
        return self.initial_novelty() > 0.0 and self.steady_novelty() <= 0.0


@dataclass
class TraceState:
    e: float = 0.0
    i: float = 0.0
    last_event: int | None = None


@dataclass(frozen=True)
class SurpriseEvent:
    event_index: int
    key: str
    e_pre: float
    i_pre: float
    e_post: float
    i_post: float
    novelty: float
    seen_before: bool
    gap: int


class CerebellarSurpriseBank:
    """Lazy event-addressed two-timescale reference state."""

    def __init__(self, config: TraceConfig | None = None):
        self.config = config or TraceConfig()
        self.config.validate()
        self.states: dict[str, TraceState] = {}

    @staticmethod
    def canonical_key(key: Hashable) -> str:
        if isinstance(key, str):
            return key
        return json.dumps(key, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def observe(self, key: Hashable, event_index: int) -> SurpriseEvent:
        if event_index < 0:
            raise ValueError("event_index must be non-negative")
        k = self.canonical_key(key)
        state = self.states.get(k)
        seen = state is not None
        if state is None:
            state = TraceState()
            self.states[k] = state

        if state.last_event is None:
            gap = self.config.nominal_gap
        else:
            gap = event_index - state.last_event
            if gap <= 0:
                raise ValueError("event indices for one key must increase")

        ae, ai = self.config.alpha_e(gap), self.config.alpha_i(gap)
        e_pre, i_pre = state.e * ae, state.i * ai
        e_post = e_pre + self.config.increment_e
        i_post = i_pre + self.config.increment_i
        state.e, state.i, state.last_event = e_post, i_post, event_index
        return SurpriseEvent(
            event_index=event_index,
            key=k,
            e_pre=e_pre,
            i_pre=i_pre,
            e_post=e_post,
            i_post=i_post,
            novelty=i_post - e_post,
            seen_before=seen,
            gap=gap,
        )

    def snapshot(self) -> dict:
        return {
            "schema": SCHEMA,
            "config": asdict(self.config),
            "states": {
                k: {"e": s.e, "i": s.i, "last_event": s.last_event}
                for k, s in sorted(self.states.items())
            },
        }

    def snapshot_bytes(self) -> bytes:
        return json.dumps(
            self.snapshot(), sort_keys=True, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False,
        ).encode("utf-8")

    def digest(self) -> str:
        return hashlib.sha256(self.snapshot_bytes()).hexdigest()

    @classmethod
    def from_snapshot_bytes(cls, payload: bytes) -> "CerebellarSurpriseBank":
        obj = json.loads(payload.decode("utf-8"))
        if obj.get("schema") != SCHEMA:
            raise ValueError("snapshot schema mismatch")
        bank = cls(TraceConfig(**obj["config"]))
        for key, row in obj["states"].items():
            bank.states[key] = TraceState(
                e=float(row["e"]),
                i=float(row["i"]),
                last_event=None if row["last_event"] is None else int(row["last_event"]),
            )
        return bank

    def cost_ledger(self) -> dict:
        packed = struct.calcsize("<ddq")  # E, I, last_event
        sample = TraceState()
        python_lower_bound = sys.getsizeof(sample) + sys.getsizeof(sample.__dict__)
        return {
            "schema": "archie/cerebellar-surprise-cost-ledger-v1",
            "active_keys": len(self.states),
            "packed_algorithmic_bytes_per_key": packed,
            "packed_algorithmic_bytes_total": packed * len(self.states),
            "python_object_lower_bound_bytes_per_key_excluding_key_and_hash_table": python_lower_bound,
            "reference_ops_per_event": {
                "hash_lookup": 1,
                "exp": 2,
                "multiply": 2,
                "add": 2,
                "novelty_subtract": 1,
                "state_writes": 3,
            },
            "optimization_boundary": (
                "For discrete gaps, decay factors can be cached, eliminating hot exp calls. "
                "The reference keeps exp explicit so semantics remain inspectable."
            ),
        }


def affine_saturating_step(previous: float, decay: float, base: float, capacity: float) -> float:
    if capacity <= 0.0 or not 0.0 <= base <= capacity:
        raise ValueError("require capacity>0 and 0<=base<=capacity")
    pre = decay * previous
    return pre + base * (1.0 - pre / capacity)


def affine_saturating_closed_form(previous: float, decay: float, base: float, capacity: float) -> float:
    return decay * (1.0 - base / capacity) * previous + base


def affine_equivalence_court(gaps: Iterable[int]) -> dict:
    x_rule = x_closed = 0.173
    tau, base, capacity = 2.43, 0.0444, 1.0
    max_error = 0.0
    steps = 0
    for gap in gaps:
        if gap <= 0:
            raise ValueError("gaps must be positive")
        decay = math.exp(-gap / tau)
        x_rule = affine_saturating_step(x_rule, decay, base, capacity)
        x_closed = affine_saturating_closed_form(x_closed, decay, base, capacity)
        max_error = max(max_error, abs(x_rule - x_closed))
        steps += 1
    return {
        "steps": steps,
        "max_abs_error": max_error,
        "equivalent_within_1e-12": max_error <= 1e-12,
        "consequence": (
            "linear saturation plus exponential decay is an affine filter; "
            "paired traces of this restricted form are not software novelty"
        ),
    }


class OneTraceFamiliarity:
    """Cheaper event-addressed familiarity baseline."""

    def __init__(self, tau: float = 5.0, increment: float = 1.0):
        self.tau = tau
        self.increment = increment
        self.state: dict[str, tuple[float, int]] = {}

    def observe(self, key: Hashable, event_index: int) -> float:
        k = CerebellarSurpriseBank.canonical_key(key)
        old, last = self.state.get(k, (0.0, event_index - 1))
        gap = event_index - last
        if gap <= 0:
            raise ValueError("event indices for one key must increase")
        pre = old * math.exp(-gap / self.tau)
        score = 1.0 / (1.0 + pre)
        self.state[k] = (pre + self.increment, event_index)
        return score


class TransitionPredictionError:
    """Categorical next-event prediction-error baseline."""

    def __init__(self):
        self.counts: dict[str, dict[str, int]] = {}

    def observe(self, previous: str, current: str) -> float:
        row = self.counts.setdefault(previous, {})
        total = sum(row.values())
        predicted = max(row, key=row.get) if row else None
        error = 1.0 if predicted is None or predicted != current else 0.0
        row[current] = row.get(current, 0) + 1
        return error


def transition_keys(symbols: Iterable[str]) -> list[tuple[str, str]]:
    values = list(symbols)
    return list(zip(values, values[1:]))


def action_loop_gate(
    novelty: float,
    objective_progress_delta: float,
    semantic_repeat_count: int,
    *,
    repeat_limit: int = 2,
) -> dict:
    """Break stagnant repetition without worshipping novelty.

    Familiar repetition remains allowed when it is making objective progress.
    Surprise is evidence for reconsideration, never a utility function.
    """
    stagnant = objective_progress_delta <= 0.0
    repeated = semantic_repeat_count >= repeat_limit
    suppress = bool(stagnant and repeated)
    return {
        "suppress_repeated_action": suppress,
        "allow_exploration": suppress,
        "novelty_feature": float(novelty),
        "stagnant": stagnant,
        "semantic_repeat_count": int(semantic_repeat_count),
        "principle": "novelty_is_evidence_not_utility",
    }


def scalar_value_counterexample() -> dict:
    bank = CerebellarSurpriseBank()
    left = bank.observe(("state", "action-A", "consequence-X"), 1)
    right = bank.observe(("state", "action-B", "consequence-Y"), 2)
    tied = math.isclose(left.novelty, right.novelty, rel_tol=0.0, abs_tol=1e-15)
    return {
        "same_scalar_novelty": tied,
        "left_novelty": left.novelty,
        "right_novelty": right.novelty,
        "future_value": {left.key: +1.0, right.key: -1.0},
        "scalar_can_rank_future_value": False if tied else None,
        "consequence": (
            "Equal surprise can precede opposite value. Keep value and uncertainty "
            "separate from the surprise feature."
        ),
    }


def baseline_court(cfg: TraceConfig) -> dict:
    # Simple unseen-event task.
    ei = CerebellarSurpriseBank(cfg)
    one = OneTraceFamiliarity()
    ei_known = [ei.observe("known", i).novelty for i in range(1, 25)]
    one_known = [one.observe("known", i) for i in range(1, 25)]
    ei_new = ei.observe("new", 25).novelty
    one_new = one.observe("new", 25)
    threshold_ei, threshold_one = 0.2, 0.7
    ei_fpr = sum(x > threshold_ei for x in ei_known[10:]) / len(ei_known[10:])
    one_fpr = sum(x > threshold_one for x in one_known[10:]) / len(one_known[10:])

    # Order task: symbols are familiar; transition A->C is new.
    ei_order = CerebellarSurpriseBank(cfg)
    one_order = OneTraceFamiliarity()
    pred = TransitionPredictionError()
    event_index = 0
    last: str | None = None
    normal_pred: list[float] = []
    for _ in range(20):
        for symbol in ("A", "B", "C"):
            if last is not None:
                event_index += 1
                key = (last, symbol)
                ei_order.observe(key, event_index)
                one_order.observe(key, event_index)
                normal_pred.append(pred.observe(last, symbol))
            last = symbol
    event_index += 1
    ei_order.observe((last, "A"), event_index)
    one_order.observe((last, "A"), event_index)
    pred.observe(last, "A")
    last = "A"
    event_index += 1
    dev_ei = ei_order.observe((last, "C"), event_index).novelty
    dev_one = one_order.observe((last, "C"), event_index)
    dev_pred = pred.observe(last, "C")

    dual_identity = affine_equivalence_court([1, 3, 2, 1, 7] * 64)
    dominated = bool(
        ei_new > threshold_ei
        and one_new > threshold_one
        and one_fpr <= ei_fpr
        and 16 < 24
    )
    return {
        "schema": "archie/cerebellar-surprise-baselines-v1",
        "simple_unseen_event": {
            "ei": {"detection_delay_events": 0 if ei_new > threshold_ei else None, "fpr_after_burnin": ei_fpr, "packed_bytes_per_key": 24, "score": ei_new},
            "one_trace": {"detection_delay_events": 0 if one_new > threshold_one else None, "fpr_after_burnin": one_fpr, "packed_bytes_per_key": 16, "score": one_new},
            "ei_dominated_by_one_trace_on_this_task": dominated,
        },
        "order_perturbation": {
            "ei_transition_score": dev_ei,
            "one_trace_transition_score": dev_one,
            "prediction_error": dev_pred,
            "all_detect_same_event": bool(dev_ei > threshold_ei and dev_one > threshold_one and dev_pred > 0.5),
            "normal_prediction_error_tail": normal_pred[-6:],
        },
        "dual_ema": {
            "identity_with_restricted_affine_ei": dual_identity["equivalent_within_1e-12"],
            "max_abs_equivalence_error": dual_identity["max_abs_error"],
        },
    }


def run_reference_court() -> dict:
    cfg = TraceConfig()
    bank = CerebellarSurpriseBank(cfg)
    familiar = [bank.observe("familiar", i).novelty for i in range(1, 25)]
    deviant_first = bank.observe("deviant", 25).novelty
    deviant_repeat = [bank.observe("deviant", i).novelty for i in range(26, 50)]

    # Transition-addressed state detects order changes without claiming symbol novelty.
    order_bank = CerebellarSurpriseBank(cfg)
    idx = 0
    normal_scores: list[float] = []
    for _ in range(12):
        for key in transition_keys(("A", "B", "C", "A")):
            idx += 1
            normal_scores.append(order_bank.observe(key, idx).novelty)
    idx += 1
    order_deviant = order_bank.observe(("A", "C"), idx).novelty

    # Save/restart/replay must be byte deterministic.
    payload = bank.snapshot_bytes()
    restored = CerebellarSurpriseBank.from_snapshot_bytes(payload)
    replay_before = restored.snapshot_bytes() == payload
    left = bank.observe("familiar", 60)
    right = restored.observe("familiar", 60)
    replay_after = left == right and bank.snapshot_bytes() == restored.snapshot_bytes()

    equivalence = affine_equivalence_court([1, 2, 1, 5, 3, 1, 8, 2] * 128)
    baselines = baseline_court(cfg)
    counterexample = scalar_value_counterexample()
    ledger = bank.cost_ledger()

    # Real resident regression: semantic repetition is suppressed only when it
    # produces no progress; productive repetition is retained.
    stagnant = action_loop_gate(0.01, 0.0, 2)
    productive = action_loop_gate(0.01, +0.2, 8)

    checks = {
        "analytic_parameter_region": cfg.supports_one_event_then_habituation(),
        "familiar_habituates": familiar[-1] < 0.0 and familiar[-1] < familiar[0],
        "deviant_detected_same_event": deviant_first > 0.0 and deviant_first > familiar[-1],
        "repeated_deviant_adapts": deviant_repeat[-1] < 0.0 and deviant_repeat[-1] < deviant_first,
        "order_perturbation_detected": order_deviant > 0.0 and order_deviant > normal_scores[-1],
        "snapshot_replay_byte_deterministic": replay_before and replay_after,
        "affine_equivalence_falsifier": equivalence["equivalent_within_1e-12"],
        "scalar_value_counterexample": counterexample["same_scalar_novelty"] and not counterexample["scalar_can_rank_future_value"],
        "stagnant_action_loop_breaks": stagnant["suppress_repeated_action"],
        "productive_repetition_preserved": not productive["suppress_repeated_action"],
        "matched_baseline_court": (
            baselines["simple_unseen_event"]["ei_dominated_by_one_trace_on_this_task"]
            and baselines["order_perturbation"]["all_detect_same_event"]
            and baselines["dual_ema"]["identity_with_restricted_affine_ei"]
        ),
    }

    return {
        "schema": "archie/cerebellar-surprise-court-v1",
        "pass": all(checks.values()),
        "promotion": False,
        "promotion_reason": (
            "NO_PROMOTION: restricted E/I is equivalent to a two-pole affine filter, "
            "and a one-trace familiarity baseline solves the simplest event novelty task "
            "with less state. Retain event-addressed surprise only as a candidate scheduler."
        ),
        "checks": checks,
        "metrics": {
            "initial_ei_novelty": cfg.initial_novelty(),
            "analytic_steady_ei_novelty": cfg.steady_novelty(),
            "familiar_novelty_first": familiar[0],
            "familiar_novelty_last": familiar[-1],
            "deviant_novelty_first": deviant_first,
            "deviant_novelty_last": deviant_repeat[-1],
            "order_normal_last": normal_scores[-1],
            "order_deviant": order_deviant,
        },
        "equivalence": equivalence,
        "baselines": baselines,
        "cost": ledger,
        "counterexample": counterexample,
        "action_loop_regression": {"stagnant": stagnant, "productive": productive},
        "falsified_claims": [
            "unequal E/I time constants alone constitute novel software architecture",
            "scalar novelty alone is sufficient memory-write or action utility",
            "passing unseen-event detection justifies replacing a one-trace familiarity baseline",
        ],
        "paper_boundary": (
            "Inspired by event-driven E/I time-scale competition. Not a device emulator; "
            "does not reproduce the paper's measured nonlinear pulse-history fit coefficients."
        ),
        "next_earned_experiment": (
            "Use measured pulse-history-dependent increments and test whether the resulting "
            "non-affine rule beats matched one-/multi-EMA and prediction-error baselines on "
            "resident action/consequence streams."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_reference_court()
    text = json.dumps(result, indent=2, sort_keys=True, allow_nan=False)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
