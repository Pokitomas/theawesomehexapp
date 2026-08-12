#!/usr/bin/env python3
"""One developmental loop: uncertain causes -> safe experiment -> receipt -> consolidation.

This court composes several independently tested ARCHIE ideas into one state
machine instead of celebrating them as separate breakthroughs:

  causal belief
    -> decision-relevant value-of-information planner
    -> safe/reversible probe
    -> exact observed effect + receipt
    -> eliminate incompatible hypotheses
    -> receipt-gated durable operator claim

If the planner cannot justify a safe probe, the loop keeps multiple hypotheses
alive and deliberately refuses to mint a stable causal fact.  The semantic
surface may still say "uncertain"; it may not choose a prettier branch.

The toy world has four hidden hypotheses. H1/H2 are operationally equivalent
for the current downstream decision and H3/H4 form another decision class. A
probe at the decision boundary tells us which class is true, but not which exact
member. Therefore one observation may legitimately change the action while
*still* being insufficient for exact operator consolidation. A second cheap
probe can identify the within-class member when exact identity later becomes
valuable.

That distinction matters: decision sufficiency and world-model identity are not
the same compression target.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VOI_PATH = HERE / "risk_constrained_value_of_information.py"
EVIDENCE_PATH = HERE / "evidence_gated_consolidation.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


V = load_module("archie_developmental_voi", VOI_PATH)
E = load_module("archie_developmental_evidence", EVIDENCE_PATH)
NOW_NS = 1_786_500_000_000_000_000


def artifact_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def initial_hypotheses() -> list[V.Hypothesis]:
    return [
        V.Hypothesis("h1", 0.375, "A"),
        V.Hypothesis("h2", 0.375, "A"),
        V.Hypothesis("h3", 0.125, "B"),
        V.Hypothesis("h4", 0.125, "B"),
    ]


def decisions(stakes: float) -> list[V.Decision]:
    return [
        V.Decision("act_A", {"A": stakes, "B": 0.0}),
        V.Decision("act_B", {"A": 0.0, "B": stakes}),
    ]


def boundary_probe(cost: float = 0.20, risk: float = 0.01) -> V.Probe:
    return V.Probe(
        "decision_boundary",
        {"h1": "A", "h2": "A", "h3": "B", "h4": "B"},
        actuation_cost=cost,
        risk=risk,
        reversible=True,
        receipt_backend="developmental-loop/sandbox-probe",
    )


def identity_probe(cost: float = 0.05, risk: float = 0.01) -> V.Probe:
    return V.Probe(
        "within_class_identity",
        {"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h4"},
        actuation_cost=cost,
        risk=risk,
        reversible=True,
        receipt_backend="developmental-loop/sandbox-probe",
    )


def unsafe_identity_probe() -> V.Probe:
    return V.Probe(
        "unsafe_identity",
        {"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h4"},
        actuation_cost=0.0,
        risk=0.95,
        reversible=False,
        receipt_backend="developmental-loop/sandbox-probe",
    )


def posterior_after_observation(
    belief: dict[str, float],
    probe: V.Probe,
    observed: str,
) -> dict[str, float]:
    surviving = {
        name: probability
        for name, probability in belief.items()
        if probe.outcome_by_hypothesis[name] == observed
    }
    total = sum(surviving.values())
    if total <= 0.0:
        raise RuntimeError("observation falsified every causal hypothesis")
    return {name: probability / total for name, probability in surviving.items()}


def hypotheses_from_belief(
    original: dict[str, V.Hypothesis],
    belief: dict[str, float],
) -> list[V.Hypothesis]:
    return [
        V.Hypothesis(name, probability, original[name].decision_class)
        for name, probability in belief.items()
    ]


def fresh_sensor_receipt(claim: E.Claim, effect: dict[str, Any]) -> E.Receipt:
    return E.Receipt(
        kind="sensor",
        claim_hash=claim.claim_hash,
        verifier="developmental-loop/sandbox-effect-verifier",
        artifact_hash=artifact_hash(effect),
        verdict="pass",
        issued_ns=NOW_NS - 10,
        expires_ns=NOW_NS + 10_000,
    )


def attempt_identity_consolidation(
    memory: E.EvidenceGatedMemory,
    belief: dict[str, float],
    effect_receipt_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    if len(belief) != 1:
        # Deliberately emit only a volatile set-valued hypothesis. There is no
        # exact operator fact to stabilize yet.
        claim = E.Claim(
            "toy_operator",
            "compatible_hypotheses",
            ",".join(sorted(belief)),
            "causal",
        )
        event = memory.propose(claim, None)
        return {"result": "unresolved", "memory_event": event, "stable_identity": False}

    identity = next(iter(belief))
    claim = E.Claim("toy_operator", "identity", identity, "causal")
    if effect_receipt_payload is None:
        event = memory.propose(claim, None)
        return {"result": "unproved_singleton", "memory_event": event, "stable_identity": False}
    receipt = fresh_sensor_receipt(claim, effect_receipt_payload)
    event = memory.propose(claim, receipt)
    return {"result": event["result"], "memory_event": event, "stable_identity": event["result"] == "stable"}


def run_high_stakes_truth(truth: str) -> dict[str, Any]:
    original = {h.name: h for h in initial_hypotheses()}
    config = V.PlannerConfig(risk_limit=0.20, risk_penalty=0.25)
    belief = V.normalize_belief(list(original.values()))
    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)

    # Phase 1: exact identity is not decision-relevant. The cheap class probe is
    # selected; its observation changes the optimal action but leaves two causes.
    plan1 = V.choose_probe(
        hypotheses_from_belief(original, belief),
        decisions(stakes=10.0),
        [boundary_probe(), identity_probe(cost=5.0)],
        config,
    )
    selected1 = plan1["selected_probe"]
    if not selected1:
        raise RuntimeError("high-stakes phase should choose a probe")
    probe1 = boundary_probe()
    observed1 = probe1.outcome_by_hypothesis[truth]
    effect1 = {
        "probe": probe1.name,
        "observed": observed1,
        "truth_hidden_from_planner": truth,
        "receipt_backend": probe1.receipt_backend,
    }
    belief = posterior_after_observation(belief, probe1, observed1)
    consolidation1 = attempt_identity_consolidation(memory, belief, effect1)
    action1, action1_utility = V.best_decision(belief, original, decisions(10.0))

    # Phase 2: later task explicitly values exact identity. Model that as four
    # decision classes, one per hypothesis. The identity probe now has VOI.
    exact_original = {
        name: V.Hypothesis(name, probability, name)
        for name, probability in belief.items()
    }
    exact_decisions = [
        V.Decision(f"choose_{name}", {other: (20.0 if other == name else 0.0) for other in exact_original})
        for name in exact_original
    ]
    plan2 = V.choose_probe(
        list(exact_original.values()),
        exact_decisions,
        [identity_probe(), unsafe_identity_probe()],
        config,
    )
    selected2 = plan2["selected_probe"]
    if not selected2:
        raise RuntimeError("identity-valued phase should choose safe identity probe")
    probe2 = identity_probe()
    observed2 = probe2.outcome_by_hypothesis[truth]
    effect2 = {
        "probe": probe2.name,
        "observed": observed2,
        "truth_hidden_from_planner": truth,
        "receipt_backend": probe2.receipt_backend,
    }
    belief = posterior_after_observation(belief, probe2, observed2)
    consolidation2 = attempt_identity_consolidation(memory, belief, effect2)

    snap = memory.snapshot()
    identity_key = E.Claim("toy_operator", "identity", truth, "causal").key
    stable_identity = snap["stable"].get(identity_key, {}).get("value")
    return {
        "truth": truth,
        "phase1_plan": plan1,
        "phase1_observation": observed1,
        "phase1_belief": {k: v for k, v in sorted(posterior_after_observation(V.normalize_belief(list(original.values())), probe1, observed1).items())},
        "phase1_action": action1.name,
        "phase1_action_expected_utility": action1_utility,
        "phase1_consolidation": consolidation1,
        "phase2_plan": plan2,
        "phase2_observation": observed2,
        "final_belief": belief,
        "phase2_consolidation": consolidation2,
        "stable_identity": stable_identity,
        "stable_count": len(snap["stable"]),
        "volatile_count": sum(len(rows) for rows in snap["volatile"].values()),
    }


def run_unsafe_case() -> dict[str, Any]:
    # Exact identity matters, but the only identifying probe is unsafe. The loop
    # must preserve a two-hypothesis belief and create no stable identity.
    original = {
        "h1": V.Hypothesis("h1", 0.5, "h1"),
        "h2": V.Hypothesis("h2", 0.5, "h2"),
    }
    decisions_exact = [
        V.Decision("choose_h1", {"h1": 50.0, "h2": 0.0}),
        V.Decision("choose_h2", {"h1": 0.0, "h2": 50.0}),
    ]
    unsafe = V.Probe(
        "unsafe_binary_identity",
        {"h1": "h1", "h2": "h2"},
        actuation_cost=0.0,
        risk=0.95,
        reversible=False,
        receipt_backend="developmental-loop/sandbox-probe",
    )
    config = V.PlannerConfig(risk_limit=0.20, risk_penalty=0.25)
    plan = V.choose_probe(list(original.values()), decisions_exact, [unsafe], config)
    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    belief = V.normalize_belief(list(original.values()))
    consolidation = attempt_identity_consolidation(memory, belief, None)
    snap = memory.snapshot()
    return {
        "plan": plan,
        "belief": belief,
        "consolidation": consolidation,
        "stable_count": len(snap["stable"]),
        "volatile_count": sum(len(rows) for rows in snap["volatile"].values()),
    }


def run_court() -> dict[str, Any]:
    truths = [run_high_stakes_truth(name) for name in ("h1", "h2", "h3", "h4")]
    unsafe = run_unsafe_case()
    passed = bool(
        all(r["phase1_plan"]["selected_probe"]["name"] == "decision_boundary" for r in truths)
        and all(len(r["phase1_belief"]) == 2 for r in truths)
        and all(not r["phase1_consolidation"]["stable_identity"] for r in truths)
        and all(r["phase2_plan"]["selected_probe"]["name"] == "within_class_identity" for r in truths)
        and all(len(r["final_belief"]) == 1 for r in truths)
        and all(r["phase2_consolidation"]["stable_identity"] for r in truths)
        and all(r["stable_identity"] == r["truth"] for r in truths)
        and unsafe["plan"]["disposition"] == "preserve_uncertainty"
        and len(unsafe["belief"]) == 2
        and unsafe["stable_count"] == 0
        and not unsafe["consolidation"]["stable_identity"]
    )
    return {
        "schema": "archie-action-latent/developmental-causal-loop-v1",
        "pass": passed,
        "truth_runs": truths,
        "unsafe_case": unsafe,
        "architectural_consequence": (
            "The resident world model can stay compact without pretending uncertainty disappeared: resolve only distinctions needed by the current decision, keep exact compatible hypotheses as a belief set, and purchase finer identity later if it becomes valuable. "
            "Durable causal identity is a receipt-backed consolidation event, not a side effect of fluent language or a softmax argmax."
        ),
        "recursive_next_break": (
            "Remove the declared hypothesis list. Let unexplained residuals spawn candidate operators, use safe interventions to falsify them, merge observationally equivalent candidates, and charge model complexity against future decision regret."
        ),
        "claim_boundary": (
            "PASS composes the planner and evidence memory in a finite deterministic sandbox. It does not yet discover novel hypotheses, estimate real-world utility/risk, or execute on the live host."
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
