#!/usr/bin/env python3
"""Keep causal uncertainty as lawful branches instead of hallucinating an average state.

The current operator courts exposed two linked defects:

1. one transition can be exactly compatible with multiple persistent operators;
2. convexly averaging distinct lawful operators destroys their algebra and can
   produce a state that no hypothesis predicts.

This court uses the exact alias from `second_order_action_identity_court.py`:

    U(x) = R90 x
    V(x) = x + (-1,+1)
    x0=(1,0) -> x1=(0,1) under both.

After the first transition, epistemically correct state is not an averaged
operator. It is a finite measure over two causal hypotheses. The hypotheses
predict x2=(-1,0) and x2=(-1,2). Their arithmetic mean (-1,1) is predicted by
neither branch: it is a literal invented world-state caused only by premature
contraction of uncertainty.

An exact observation of x2 then filters the branch measure to one surviving
operator, after which the next state is predicted exactly. The mechanism is a
small causal-belief type, not Bayesian mystique: preserve alternatives until an
observation/intervention distinguishes them; only then contract.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

Vec = tuple[int, int]


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1])


def r90(x: Vec) -> Vec:
    return (-x[1], x[0])


def translate(x: Vec) -> Vec:
    return add(x, (-1, 1))


@dataclass(frozen=True)
class Hypothesis:
    name: str
    step: Callable[[Vec], Vec]


@dataclass
class Branch:
    hypothesis: Hypothesis
    weight: Fraction


class OperatorBelief:
    def __init__(self, branches: list[Branch]):
        total = sum((b.weight for b in branches), Fraction(0, 1))
        if total <= 0:
            raise ValueError("belief must have positive mass")
        self.branches = [Branch(b.hypothesis, b.weight / total) for b in branches]

    def compatible_update(self, state: Vec, observed_next: Vec) -> dict[str, Any]:
        survivors = [b for b in self.branches if b.hypothesis.step(state) == observed_next]
        eliminated = [b.hypothesis.name for b in self.branches if b not in survivors]
        if not survivors:
            return {"result": "model_set_falsified", "eliminated": eliminated}
        total = sum((b.weight for b in survivors), Fraction(0, 1))
        self.branches = [Branch(b.hypothesis, b.weight / total) for b in survivors]
        return {
            "result": "updated",
            "survivors": [b.hypothesis.name for b in self.branches],
            "weights": {b.hypothesis.name: f"{b.weight.numerator}/{b.weight.denominator}" for b in self.branches},
            "eliminated": eliminated,
        }

    def predict_support(self, state: Vec) -> list[dict[str, Any]]:
        grouped: dict[Vec, Fraction] = {}
        names: dict[Vec, list[str]] = {}
        for branch in self.branches:
            nxt = branch.hypothesis.step(state)
            grouped[nxt] = grouped.get(nxt, Fraction(0, 1)) + branch.weight
            names.setdefault(nxt, []).append(branch.hypothesis.name)
        return [
            {
                "state": list(state_key),
                "weight": f"{weight.numerator}/{weight.denominator}",
                "hypotheses": sorted(names[state_key]),
            }
            for state_key, weight in sorted(grouped.items())
        ]

    def expected_state(self, state: Vec) -> tuple[Fraction, Fraction]:
        x = Fraction(0, 1)
        y = Fraction(0, 1)
        for branch in self.branches:
            nxt = branch.hypothesis.step(state)
            x += branch.weight * nxt[0]
            y += branch.weight * nxt[1]
        return x, y


def as_fraction_pair(x: tuple[Fraction, Fraction]) -> list[str]:
    return [f"{v.numerator}/{v.denominator}" for v in x]


def support_contains_fraction(support: list[dict[str, Any]], point: tuple[Fraction, Fraction]) -> bool:
    for row in support:
        sx, sy = row["state"]
        if Fraction(sx, 1) == point[0] and Fraction(sy, 1) == point[1]:
            return True
    return False


def run_branch(truth: str) -> dict[str, Any]:
    hypotheses = [Hypothesis("rotation", r90), Hypothesis("translation", translate)]
    belief = OperatorBelief([Branch(h, Fraction(1, 2)) for h in hypotheses])
    x0: Vec = (1, 0)
    x1: Vec = (0, 1)

    first_update = belief.compatible_update(x0, x1)
    support_x2 = belief.predict_support(x1)
    expected_x2 = belief.expected_state(x1)
    mean_is_lawful_support = support_contains_fraction(support_x2, expected_x2)

    true_h = next(h for h in hypotheses if h.name == truth)
    observed_x2 = true_h.step(x1)
    second_update = belief.compatible_update(x1, observed_x2)
    support_x3 = belief.predict_support(observed_x2)
    predicted_x3 = tuple(support_x3[0]["state"]) if len(support_x3) == 1 else None
    true_x3 = true_h.step(observed_x2)

    return {
        "truth": truth,
        "first_update": first_update,
        "x2_support": support_x2,
        "premature_expected_x2": as_fraction_pair(expected_x2),
        "premature_expected_x2_is_any_lawful_branch": mean_is_lawful_support,
        "observed_x2": list(observed_x2),
        "second_update": second_update,
        "posterior_x3_support": support_x3,
        "true_x3": list(true_x3),
        "posterior_future_exact": predicted_x3 == true_x3,
    }


def run_court() -> dict[str, Any]:
    runs = [run_branch("rotation"), run_branch("translation")]
    passed = bool(
        all(len(r["first_update"]["survivors"]) == 2 for r in runs)
        and all(len(r["x2_support"]) == 2 for r in runs)
        and all(r["premature_expected_x2"] == ["-1/1", "1/1"] for r in runs)
        and all(not r["premature_expected_x2_is_any_lawful_branch"] for r in runs)
        and all(len(r["second_update"]["survivors"]) == 1 for r in runs)
        and all(r["posterior_future_exact"] for r in runs)
    )
    return {
        "schema": "archie-action-latent/operator-belief-filter-court-v1",
        "pass": passed,
        "runs": runs,
        "architectural_consequence": (
            "Uncertainty over causal operators is a typed branch dimension, not a fuzzy averaged transformation. Keep lawful hypotheses and their weights until evidence distinguishes them. "
            "This prevents uncertainty itself from fabricating an impossible mean world-state and gives repeated intervention a mechanical role in belief collapse."
        ),
        "integration": (
            "Combine this branch measure with evidence-gated consolidation: branch weights may change from observations, but a persistent operator is promoted to stable memory only when the distinguishing transition carries a current sensor/court receipt. "
            "Exact episodic residuals retain eliminated-counterexample lineage instead of deleting it."
        ),
        "claim_boundary": (
            "PASS is an exact two-hypothesis causal filtering witness. It does not solve large hypothesis-set scaling, noisy observations, active experiment selection, or continuous operator inference."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court()
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
