#!/usr/bin/env python3
"""Court whether history-dependent plasticity earns more state expressivity than two EMAs.

The first cerebellar-inspired software court deliberately killed the weak claim:
two exponential E/I traces with affine pulse updates are just a two-pole filter
bank.  This follow-up asks the smallest stronger question we can justify from
the device motif: can a *state-dependent* pulse response distinguish histories
that an equally-sized pair of linear exponential traces provably aliases?

This is not a device emulator and it is not a utility/promotion claim.  It is a
representational separation court.  Both competitors keep two scalar states.
The histories are constructed with exact rational arithmetic so the linear
collision is a theorem, not a floating-point accident.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
import math
from pathlib import Path
from typing import Iterable, Sequence


SCHEMA = "archie/cerebellar-nonlinear-history-court-v1"


History = tuple[Fraction, ...]


@dataclass(frozen=True)
class NonlinearTrace:
    decay: float
    gain: float
    capacity: float = 2.0
    exponent: int = 2

    def validate(self) -> None:
        if not 0.0 < self.decay < 1.0:
            raise ValueError("decay must be in (0,1)")
        if not self.gain > 0.0:
            raise ValueError("gain must be positive")
        if not self.capacity > 0.0:
            raise ValueError("capacity must be positive")
        if self.exponent < 2:
            raise ValueError("court requires genuinely nonlinear exponent >= 2")


def exact_linear_state(history: Sequence[Fraction], decay: Fraction) -> Fraction:
    state = Fraction(0)
    for pulse in history:
        state = decay * state + pulse
    return state


def dual_linear_state(
    history: Sequence[Fraction],
    decays: tuple[Fraction, Fraction] = (Fraction(1, 2), Fraction(3, 4)),
) -> tuple[Fraction, Fraction]:
    return tuple(exact_linear_state(history, decay) for decay in decays)  # type: ignore[return-value]


def nonlinear_state(history: Sequence[Fraction], cfg: NonlinearTrace) -> float:
    cfg.validate()
    state = 0.0
    for pulse_q in history:
        pulse = float(pulse_q)
        pre = cfg.decay * state
        remaining = 1.0 - pre / cfg.capacity
        # State-dependent pulse response.  Squaring the remaining-capacity term
        # makes the write depend on the interaction between current pulse and
        # accumulated state; it cannot in general be represented by a fixed
        # affine recurrence z'=a*z+b*x.
        state = pre + cfg.gain * pulse * (remaining ** cfg.exponent)
        if not math.isfinite(state):
            raise FloatingPointError("nonlinear state became non-finite")
    return state


def paired_nonlinear_state(history: Sequence[Fraction]) -> tuple[float, float]:
    excitatory = nonlinear_state(
        history,
        NonlinearTrace(decay=0.8, gain=0.4, capacity=2.0, exponent=2),
    )
    inhibitory = nonlinear_state(
        history,
        NonlinearTrace(decay=0.3, gain=0.6, capacity=2.0, exponent=2),
    )
    return excitatory, inhibitory


def histories() -> tuple[History, History, tuple[Fraction, ...]]:
    """Return exact colliding histories and the null-space perturbation.

    With four pulses, the final states of two fixed linear filters with decays
    1/2 and 3/4 are two linear constraints.  The vector (8,-10,3,0) lies in the
    null space of both final-state maps:

      [1/8, 1/4, 1/2, 1] . v = 0
      [27/64, 9/16, 3/4, 1] . v = 0

    Around baseline 1/2 with epsilon 1/25, both histories stay in [0,1].
    """
    base = (Fraction(1, 2),) * 4
    null = (Fraction(8), Fraction(-10), Fraction(3), Fraction(0))
    epsilon = Fraction(1, 25)
    plus = tuple(b + epsilon * v for b, v in zip(base, null))
    minus = tuple(b - epsilon * v for b, v in zip(base, null))
    return plus, minus, null


def _float_pair(values: Iterable[Fraction]) -> list[float]:
    return [float(value) for value in values]


def run_court() -> dict:
    plus, minus, null = histories()
    linear_plus = dual_linear_state(plus)
    linear_minus = dual_linear_state(minus)
    exact_collision = linear_plus == linear_minus

    nonlinear_plus = paired_nonlinear_state(plus)
    nonlinear_minus = paired_nonlinear_state(minus)
    nonlinear_delta = tuple(a - b for a, b in zip(nonlinear_plus, nonlinear_minus))
    nonlinear_linf = max(abs(value) for value in nonlinear_delta)

    # A scalar differential readout is *not* treated as utility.  It is included
    # only to show that even the E-I projection differs after the aliased
    # histories.  Equal/different surprise says nothing about future value.
    diff_plus = nonlinear_plus[1] - nonlinear_plus[0]
    diff_minus = nonlinear_minus[1] - nonlinear_minus[0]
    differential_separation = abs(diff_plus - diff_minus)

    # Exact null-space witnesses, useful when this court is changed later.
    decay_rows = (
        (Fraction(1, 8), Fraction(1, 4), Fraction(1, 2), Fraction(1)),
        (Fraction(27, 64), Fraction(9, 16), Fraction(3, 4), Fraction(1)),
    )
    null_residuals = [sum(weight * value for weight, value in zip(row, null)) for row in decay_rows]

    # Deterministic replay is a hard boundary because the mechanism is meant to
    # become resident state if it ever earns promotion.
    replay_plus = paired_nonlinear_state(plus)
    replay_minus = paired_nonlinear_state(minus)
    replay_exact = replay_plus == nonlinear_plus and replay_minus == nonlinear_minus

    result = {
        "schema": SCHEMA,
        "histories": {
            "plus": _float_pair(plus),
            "minus": _float_pair(minus),
            "same_last_pulse": plus[-1] == minus[-1],
            "all_pulses_in_unit_interval": all(Fraction(0) <= x <= Fraction(1) for x in plus + minus),
        },
        "linear_two_state_bank": {
            "decays": [0.5, 0.75],
            "plus_state_exact": [str(x) for x in linear_plus],
            "minus_state_exact": [str(x) for x in linear_minus],
            "exact_collision": exact_collision,
            "null_vector": [str(x) for x in null],
            "null_residuals_exact": [str(x) for x in null_residuals],
            "state_scalars": 2,
            "consequence": (
                "Any deterministic downstream readout of these two linear final states "
                "must give the same answer for the two histories."
            ),
        },
        "nonlinear_two_state_bank": {
            "plus_state": list(nonlinear_plus),
            "minus_state": list(nonlinear_minus),
            "state_delta": list(nonlinear_delta),
            "linf_state_separation": nonlinear_linf,
            "ei_differential_plus": diff_plus,
            "ei_differential_minus": diff_minus,
            "ei_differential_separation": differential_separation,
            "state_scalars": 2,
            "deterministic_replay_exact": replay_exact,
        },
        "checks": {
            "linear_bank_aliases_histories_exactly": exact_collision,
            "null_witness_is_exact": all(value == 0 for value in null_residuals),
            "nonlinear_bank_separates_aliased_histories": nonlinear_linf > 1e-4,
            "differential_readout_also_separates": differential_separation > 1e-4,
            "same_state_scalar_count": True,
            "deterministic_replay_exact": replay_exact,
            "inputs_are_bounded": all(Fraction(0) <= x <= Fraction(1) for x in plus + minus),
        },
        "cost": {
            "linear_state_scalars": 2,
            "nonlinear_state_scalars": 2,
            "nonlinear_extra_math": (
                "per trace/event: remaining-capacity division, exponent-2 multiply, "
                "and pulse/state interaction beyond affine EMA"
            ),
        },
        "interpretation": (
            "PASS proves only a same-state-count representational separation: a state-dependent "
            "pulse rule can remember a distinction that this fixed two-EMA bank aliases. It does "
            "not prove the nonlinear rule is useful, optimal, biologically faithful, or worth its "
            "extra arithmetic. The next promotion gate must be an action/consequence task where "
            "that additional distinction improves objective progress over matched baselines."
        ),
        "promotion": False,
    }
    result["pass"] = all(bool(value) for value in result["checks"].values())
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court()
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
