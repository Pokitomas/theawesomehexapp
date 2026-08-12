#!/usr/bin/env python3
"""Spend uncertainty only when it changes a decision, and never buy unsafe certainty.

Raw information gain is not the objective of an embodied agent.  A probe can
produce many bits while distinguishing hypotheses that imply the same action.
Conversely a lower-entropy probe can be decisive because it separates the
hypotheses across an actual decision boundary.

This court turns the current ARCHIE causal-belief line into a small planner:

    belief over lawful hypotheses
      -> expected utility of acting now
      -> candidate experiment outcomes
      -> posterior-optimal decision utility
      -> value of information (VOI)
      -> subtract actuation cost + risk penalty
      -> execute only if safe and net-positive

If no safe positive-value probe exists, the correct result is *preserve
uncertainty*, not guess and not silently average causal operators.

The adversarial case is deliberate. Four equally structured hypotheses are
weighted 0.375,0.375,0.125,0.125. H1/H2 imply decision A; H3/H4 imply B.
A nuisance probe gives a perfect 1-bit partition but mixes A/B in both outcomes,
so its decision VOI is exactly zero. A lower-entropy 0.811-bit probe separates
A from B and has positive decision value. This falsifies "maximize entropy" as
a universal experiment policy.

This is ordinary decision theory used as an architectural primitive, not a
claim of novel mathematics. The research move is where it sits: information,
memory, action, and uncertainty are charged against one distinguishability
budget instead of treating context length as the master resource.
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Hypothesis:
    name: str
    prior: float
    decision_class: str


@dataclass(frozen=True)
class Decision:
    name: str
    utility_by_class: dict[str, float]


@dataclass(frozen=True)
class Probe:
    name: str
    outcome_by_hypothesis: dict[str, str]
    actuation_cost: float = 0.0
    risk: float = 0.0
    reversible: bool = True
    receipt_backend: str = "sandbox-court"


@dataclass(frozen=True)
class PlannerConfig:
    risk_limit: float = 0.2
    risk_penalty: float = 1.0
    require_reversible: bool = True
    min_net_value: float = 1e-12


def normalize_belief(hypotheses: list[Hypothesis]) -> dict[str, float]:
    total = sum(h.prior for h in hypotheses)
    if not math.isfinite(total) or total <= 0.0:
        raise ValueError("belief must have positive finite mass")
    belief = {h.name: h.prior / total for h in hypotheses}
    if any((not math.isfinite(p) or p < 0.0) for p in belief.values()):
        raise ValueError("invalid prior")
    return belief


def entropy_bits(weights: list[float]) -> float:
    return -sum(p * math.log2(p) for p in weights if p > 0.0)


def expected_decision_utility(
    belief: dict[str, float],
    hypotheses: dict[str, Hypothesis],
    decision: Decision,
) -> float:
    return sum(
        probability * decision.utility_by_class[hypotheses[name].decision_class]
        for name, probability in belief.items()
    )


def best_decision(
    belief: dict[str, float],
    hypotheses: dict[str, Hypothesis],
    decisions: list[Decision],
) -> tuple[Decision, float]:
    scored = [
        (decision, expected_decision_utility(belief, hypotheses, decision))
        for decision in decisions
    ]
    return max(scored, key=lambda row: (row[1], row[0].name))


def posterior_for_outcome(
    belief: dict[str, float],
    probe: Probe,
    outcome: str,
) -> tuple[float, dict[str, float]]:
    members = {
        name: p
        for name, p in belief.items()
        if probe.outcome_by_hypothesis[name] == outcome
    }
    mass = sum(members.values())
    if mass <= 0.0:
        return 0.0, {}
    return mass, {name: p / mass for name, p in members.items()}


def grade_probe(
    belief: dict[str, float],
    hypotheses: dict[str, Hypothesis],
    decisions: list[Decision],
    probe: Probe,
    config: PlannerConfig,
) -> dict[str, Any]:
    prior_decision, prior_utility = best_decision(belief, hypotheses, decisions)
    prior_entropy = entropy_bits(list(belief.values()))
    outcomes = sorted(set(probe.outcome_by_hypothesis.values()))

    expected_posterior_entropy = 0.0
    expected_posterior_utility = 0.0
    outcome_rows: list[dict[str, Any]] = []
    for outcome in outcomes:
        mass, posterior = posterior_for_outcome(belief, probe, outcome)
        if mass <= 0.0:
            continue
        decision, utility = best_decision(posterior, hypotheses, decisions)
        h = entropy_bits(list(posterior.values()))
        expected_posterior_entropy += mass * h
        expected_posterior_utility += mass * utility
        outcome_rows.append({
            "outcome": outcome,
            "probability": mass,
            "posterior": posterior,
            "posterior_entropy_bits": h,
            "best_decision": decision.name,
            "best_decision_expected_utility": utility,
        })

    information_gain = prior_entropy - expected_posterior_entropy
    decision_voi = expected_posterior_utility - prior_utility
    risk_charge = config.risk_penalty * probe.risk
    net_value = decision_voi - probe.actuation_cost - risk_charge
    safety_reasons: list[str] = []
    if probe.risk > config.risk_limit:
        safety_reasons.append("risk_limit")
    if config.require_reversible and not probe.reversible:
        safety_reasons.append("not_reversible")
    if not probe.receipt_backend:
        safety_reasons.append("no_receipt_backend")
    safe = not safety_reasons

    return {
        "name": probe.name,
        "safe": safe,
        "safety_reasons": safety_reasons,
        "prior_best_decision": prior_decision.name,
        "prior_best_expected_utility": prior_utility,
        "prior_entropy_bits": prior_entropy,
        "information_gain_bits": information_gain,
        "expected_posterior_entropy_bits": expected_posterior_entropy,
        "decision_value_of_information": decision_voi,
        "actuation_cost": probe.actuation_cost,
        "risk": probe.risk,
        "risk_charge": risk_charge,
        "net_value": net_value,
        "receipt_backend": probe.receipt_backend,
        "outcomes": outcome_rows,
    }


def choose_probe(
    hypotheses: list[Hypothesis],
    decisions: list[Decision],
    probes: list[Probe],
    config: PlannerConfig,
) -> dict[str, Any]:
    hypothesis_map = {h.name: h for h in hypotheses}
    belief = normalize_belief(hypotheses)
    baseline_decision, baseline_utility = best_decision(belief, hypothesis_map, decisions)
    grades = [grade_probe(belief, hypothesis_map, decisions, probe, config) for probe in probes]
    eligible = [
        row for row in grades
        if row["safe"] and row["net_value"] > config.min_net_value
    ]
    if eligible:
        selected = max(
            eligible,
            key=lambda row: (
                row["net_value"],
                row["decision_value_of_information"],
                -row["actuation_cost"],
                row["name"],
            ),
        )
        disposition = "probe"
    else:
        selected = None
        disposition = "preserve_uncertainty"
    raw_entropy_best = max(grades, key=lambda row: (row["information_gain_bits"], row["name"])) if grades else None
    return {
        "belief": belief,
        "baseline_decision": baseline_decision.name,
        "baseline_expected_utility": baseline_utility,
        "disposition": disposition,
        "selected_probe": selected,
        "raw_entropy_best_probe": raw_entropy_best,
        "probes": grades,
    }


def decision_fixture(stakes: float = 1.0) -> tuple[list[Hypothesis], list[Decision]]:
    hypotheses = [
        Hypothesis("h1", 0.375, "A"),
        Hypothesis("h2", 0.375, "A"),
        Hypothesis("h3", 0.125, "B"),
        Hypothesis("h4", 0.125, "B"),
    ]
    decisions = [
        Decision("act_A", {"A": stakes, "B": 0.0}),
        Decision("act_B", {"A": 0.0, "B": stakes}),
    ]
    return hypotheses, decisions


def nuisance_probe(cost: float = 0.0) -> Probe:
    # Outcomes are each 75%A/25%B, same decision distribution as prior.
    return Probe(
        "nuisance_high_entropy",
        {"h1": "left", "h2": "right", "h3": "left", "h4": "right"},
        actuation_cost=cost,
        risk=0.01,
    )


def decision_probe(*, cost: float, risk: float = 0.01, reversible: bool = True) -> Probe:
    return Probe(
        "decision_boundary",
        {"h1": "A", "h2": "A", "h3": "B", "h4": "B"},
        actuation_cost=cost,
        risk=risk,
        reversible=reversible,
    )


def run_court() -> dict[str, Any]:
    config = PlannerConfig(risk_limit=0.20, risk_penalty=0.25)

    # Case 1: raw entropy and decision relevance disagree. Nuisance gives 1 bit;
    # decision probe gives H(0.75,0.25)=0.811... bits but is the only one with VOI.
    hypotheses, decisions = decision_fixture(stakes=10.0)
    relevance = choose_probe(
        hypotheses,
        decisions,
        [nuisance_probe(), decision_probe(cost=0.20)],
        config,
    )

    # Case 2: same causal ambiguity, but stakes are too low to justify the probe.
    low_hypotheses, low_decisions = decision_fixture(stakes=0.20)
    low_stakes = choose_probe(
        low_hypotheses,
        low_decisions,
        [decision_probe(cost=0.10)],
        config,
    )

    # Case 3: certainty would be valuable, but only available experiment violates
    # the hard risk boundary. Correct behavior is to remain uncertain.
    high_hypotheses, high_decisions = decision_fixture(stakes=100.0)
    unsafe = choose_probe(
        high_hypotheses,
        high_decisions,
        [decision_probe(cost=0.0, risk=0.85)],
        config,
    )

    # Case 4: an irreversible experiment is rejected even with low scalar risk.
    irreversible = choose_probe(
        high_hypotheses,
        high_decisions,
        [decision_probe(cost=0.0, risk=0.01, reversible=False)],
        config,
    )

    rel_selected = relevance["selected_probe"] or {}
    rel_entropy = relevance["raw_entropy_best_probe"] or {}
    rel_grades = {row["name"]: row for row in relevance["probes"]}
    expected_decision_entropy = entropy_bits([0.75, 0.25])

    passed = bool(
        relevance["disposition"] == "probe"
        and rel_selected.get("name") == "decision_boundary"
        and rel_entropy.get("name") == "nuisance_high_entropy"
        and abs(rel_grades["nuisance_high_entropy"]["information_gain_bits"] - 1.0) <= 1e-12
        and abs(rel_grades["nuisance_high_entropy"]["decision_value_of_information"]) <= 1e-12
        and abs(rel_grades["decision_boundary"]["information_gain_bits"] - expected_decision_entropy) <= 1e-12
        and rel_grades["decision_boundary"]["decision_value_of_information"] > 0.0
        and low_stakes["disposition"] == "preserve_uncertainty"
        and unsafe["disposition"] == "preserve_uncertainty"
        and unsafe["probes"][0]["decision_value_of_information"] > 0.0
        and "risk_limit" in unsafe["probes"][0]["safety_reasons"]
        and irreversible["disposition"] == "preserve_uncertainty"
        and "not_reversible" in irreversible["probes"][0]["safety_reasons"]
    )

    return {
        "schema": "archie-action-latent/risk-constrained-value-of-information-v1",
        "pass": passed,
        "decision_relevance_case": relevance,
        "low_stakes_case": low_stakes,
        "unsafe_certainty_case": unsafe,
        "irreversible_probe_case": irreversible,
        "architectural_consequence": (
            "Distinguishability should be purchased only when it can alter a downstream decision enough to repay compute/actuation cost and stay inside hard safety constraints. "
            "Raw entropy is not intelligence: a 1-bit nuisance distinction can be worth zero, while a lower-entropy causal distinction can be decisive."
        ),
        "memory_consequence": (
            "Unresolved hypotheses whose decision classes currently agree need not consume expensive resident precision. Keep the exact evidence externally and preserve a compact equivalence class until a decision boundary makes the distinction valuable."
        ),
        "hallucination_consequence": (
            "When a useful discriminating experiment is unsafe or too costly, keep uncertainty explicit. Do not force a single narrative just because the semantic decoder wants one."
        ),
        "claim_boundary": (
            "PASS is a finite exact decision-theoretic court with declared utilities, costs, and risks. Real utility/risk estimation is itself uncertain and must be receipt-backed or conservatively bounded."
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
