#!/usr/bin/env python3
"""Turn nonlinear history separation into a minimal consequence-grounded court.

This court is intentionally adversarial and modest.  A particular two-state
linear EMA bank (decays 1/2 and 3/4) is given balanced histories that are exact
null-space collisions for its final state.  The correct next action depends on
which history occurred.  An equal-state-count nonlinear bank is asked whether
its extra history information can drive the right action across unseen
perturbation magnitudes.

The result is NOT allowed to imply that nonlinear memory beats all linear
memories.  A different linear bank is included as an explicit counterexample:
its poles do not alias the constructed histories.  Promotion therefore remains
false even when the matched action court passes.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
from pathlib import Path
from typing import Iterable

import nonlinear_history_court as N


SCHEMA = "archie/cerebellar-nonlinear-action-consequence-court-v1"


def history_pair(epsilon: Fraction) -> tuple[N.History, N.History]:
    if epsilon <= 0:
        raise ValueError("epsilon must be positive")
    base = (Fraction(1, 2),) * 4
    null = (Fraction(8), Fraction(-10), Fraction(3), Fraction(0))
    plus = tuple(b + epsilon * v for b, v in zip(base, null))
    minus = tuple(b - epsilon * v for b, v in zip(base, null))
    if not all(Fraction(0) <= value <= Fraction(1) for value in plus + minus):
        raise ValueError("epsilon leaves the bounded pulse domain")
    return plus, minus


def inhibitory_feature(history: N.History) -> float:
    return N.paired_nonlinear_state(history)[1]


def train_nonlinear_policy(epsilon: Fraction = Fraction(1, 100)) -> dict:
    plus, minus = history_pair(epsilon)
    feature_plus = inhibitory_feature(plus)
    feature_minus = inhibitory_feature(minus)
    if feature_plus == feature_minus:
        raise RuntimeError("training pair was not separated")
    threshold = (feature_plus + feature_minus) / 2.0
    plus_is_high = feature_plus > feature_minus
    return {
        "epsilon": str(epsilon),
        "threshold": threshold,
        "plus_is_high": plus_is_high,
        "feature_plus": feature_plus,
        "feature_minus": feature_minus,
    }


def choose_nonlinear(history: N.History, policy: dict) -> str:
    high = inhibitory_feature(history) > float(policy["threshold"])
    plus = high if bool(policy["plus_is_high"]) else not high
    return "action-A" if plus else "action-B"


def reward(mode: str, action: str) -> float:
    correct = "action-A" if mode == "plus" else "action-B"
    return 1.0 if action == correct else 0.0


def exact_linear_aliases(epsilons: Iterable[Fraction]) -> bool:
    for epsilon in epsilons:
        plus, minus = history_pair(epsilon)
        if N.dual_linear_state(plus) != N.dual_linear_state(minus):
            return False
    return True


def alternate_linear_counterexample(epsilon: Fraction = Fraction(1, 25)) -> dict:
    plus, minus = history_pair(epsilon)
    decays = (Fraction(1, 3), Fraction(4, 5))
    plus_state = N.dual_linear_state(plus, decays)
    minus_state = N.dual_linear_state(minus, decays)
    return {
        "decays": [str(value) for value in decays],
        "plus_state": [str(value) for value in plus_state],
        "minus_state": [str(value) for value in minus_state],
        "separates_constructed_pair": plus_state != minus_state,
        "consequence": (
            "The null-space adversary is specific to the matched baseline poles. "
            "This court cannot support a claim that nonlinear state dominates all two-state linear memories."
        ),
    }


def run_court() -> dict:
    train_epsilon = Fraction(1, 100)
    test_epsilons = (
        Fraction(1, 80),
        Fraction(1, 60),
        Fraction(1, 50),
        Fraction(1, 40),
        Fraction(1, 30),
        Fraction(1, 25),
    )
    policy = train_nonlinear_policy(train_epsilon)

    rows = []
    nonlinear_rewards: list[float] = []
    for epsilon in test_epsilons:
        plus, minus = history_pair(epsilon)
        for mode, history in (("plus", plus), ("minus", minus)):
            action = choose_nonlinear(history, policy)
            observed_reward = reward(mode, action)
            nonlinear_rewards.append(observed_reward)
            rows.append(
                {
                    "epsilon": str(epsilon),
                    "mode": mode,
                    "inhibitory_feature": inhibitory_feature(history),
                    "action": action,
                    "reward": observed_reward,
                }
            )

    # Every matched linear final state is exactly identical for plus/minus. Any
    # deterministic readout of that state must emit one action for a balanced
    # pair, so one of the two modes is necessarily wrong: upper bound 1/2.
    matched_linear_alias = exact_linear_aliases((train_epsilon,) + test_epsilons)
    linear_deterministic_reward_upper_bound = 0.5 if matched_linear_alias else None
    nonlinear_mean_reward = sum(nonlinear_rewards) / len(nonlinear_rewards)
    alternate = alternate_linear_counterexample()

    result = {
        "schema": SCHEMA,
        "task": {
            "mode_plus_correct_action": "action-A",
            "mode_minus_correct_action": "action-B",
            "reward_correct": 1.0,
            "reward_wrong": 0.0,
            "train_epsilon": str(train_epsilon),
            "test_epsilons": [str(value) for value in test_epsilons],
            "balanced_test_episodes": len(rows),
        },
        "matched_linear_two_state_baseline": {
            "decays": ["1/2", "3/4"],
            "state_scalars": 2,
            "all_train_and_test_pairs_alias_exactly": matched_linear_alias,
            "best_deterministic_mean_reward_upper_bound": linear_deterministic_reward_upper_bound,
        },
        "nonlinear_two_state_candidate": {
            "state_scalars": 2,
            "policy": policy,
            "mean_reward": nonlinear_mean_reward,
            "rows": rows,
            "extra_objective_progress_vs_matched_linear_upper_bound": (
                nonlinear_mean_reward - 0.5 if matched_linear_alias else None
            ),
        },
        "counterexample_to_broad_superiority": alternate,
        "checks": {
            "matched_linear_alias_is_exact": matched_linear_alias,
            "nonlinear_generalizes_beyond_training_magnitude": nonlinear_mean_reward == 1.0,
            "same_dynamic_state_scalar_count": True,
            "nonlinear_changes_action_and_consequence": nonlinear_mean_reward > 0.5,
            "broad_linear_superiority_claim_is_refused": bool(alternate["separates_constructed_pair"]),
        },
        "promotion": False,
        "interpretation": (
            "PASS means the nonlinear two-state candidate turns one extra retained history distinction into "
            "better objective progress than the specifically matched aliased two-EMA baseline on this constructed "
            "task, including unseen perturbation magnitudes. The alternate-pole counterexample deliberately blocks "
            "a broader superiority claim. A resident promotion would require natural action/consequence replay or "
            "online evidence against learned matched linear and nonlinear baselines, including arithmetic cost."
        ),
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
