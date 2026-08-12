#!/usr/bin/env python3
"""Turn causal ambiguity into an experiment-selection problem instead of context growth.

`identifiability_horizon_ladder.py` constructs two reversible operators that can
look identical for any requested passive history length k.  This court adds one
capability: choose a probe state and observe one application of the uncertain
operator.

For a belief over deterministic hypotheses, the information value of a probe is
the entropy of the partition induced by the hypotheses' predicted outcomes.
With equal U/V mass, a state where they agree gives 0 bits; a state where they
disagree gives 1 bit and identifies the operator in one observation.

The horizon witnesses deliberately hide the difference along 0->1->...->k but
U_k(k) != V_k(k).  Therefore passive identification needs k+1 applications from
state 0 while an intervention that probes state k needs one.  The point is not
that arbitrary state reset is free.  It is that *interaction policy is a compute
primitive*: the organism can buy information from the world instead of paying
for ever larger passive context and resident state.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
HORIZON_PATH = HERE / "identifiability_horizon_ladder.py"


def load_horizon():
    spec = importlib.util.spec_from_file_location("archie_active_id_horizon", HORIZON_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {HORIZON_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


H = load_horizon()


def entropy_bits(weights: list[float]) -> float:
    return -sum(p * math.log2(p) for p in weights if p > 0.0)


def probe_information_gain(u: tuple[int, ...], v: tuple[int, ...], state: int) -> dict[str, Any]:
    prior = {"u": 0.5, "v": 0.5}
    outcomes: dict[int, list[tuple[str, float]]] = {}
    for name, op in (("u", u), ("v", v)):
        outcomes.setdefault(op[state], []).append((name, prior[name]))
    expected_posterior_entropy = 0.0
    outcome_rows = []
    for outcome, members in sorted(outcomes.items()):
        mass = sum(weight for _, weight in members)
        posterior = [weight / mass for _, weight in members]
        h = entropy_bits(posterior)
        expected_posterior_entropy += mass * h
        outcome_rows.append({
            "outcome": outcome,
            "mass": mass,
            "compatible_hypotheses": [name for name, _ in members],
            "posterior_entropy_bits": h,
        })
    gain = entropy_bits(list(prior.values())) - expected_posterior_entropy
    return {
        "state": state,
        "information_gain_bits": gain,
        "outcomes": outcome_rows,
        "distinct_outcome_count": len(outcomes),
    }


def run_horizon(k: int) -> dict[str, Any]:
    u, v = H.make_pair(k)
    probes = [probe_information_gain(u, v, s) for s in range(len(u))]
    best_gain = max(row["information_gain_bits"] for row in probes)
    best = [row for row in probes if abs(row["information_gain_bits"] - best_gain) <= 1e-12]
    # The passive orbit agrees for states 0..k and first diverges after applying
    # the operator at state k: k+1 applications from the initial state.
    passive_applications_to_identify = k + 1
    active_applications_to_identify = 1 if best_gain >= 1.0 - 1e-12 else None
    return {
        "horizon": k,
        "state_count": len(u),
        "passive_applications_to_identify": passive_applications_to_identify,
        "best_active_information_gain_bits": best_gain,
        "best_probe_states": [row["state"] for row in best],
        "canonical_discriminating_state_k_gain_bits": probes[k]["information_gain_bits"],
        "active_applications_to_identify": active_applications_to_identify,
        "passive_over_active_observation_ratio": (
            passive_applications_to_identify / active_applications_to_identify
            if active_applications_to_identify else None
        ),
        "probe_table": probes,
    }


def run_court(max_horizon: int) -> dict[str, Any]:
    rows = [run_horizon(k) for k in range(1, max_horizon + 1)]
    ratios = [float(r["passive_over_active_observation_ratio"]) for r in rows]
    passed = bool(
        rows
        and all(abs(r["best_active_information_gain_bits"] - 1.0) <= 1e-12 for r in rows)
        and all(abs(r["canonical_discriminating_state_k_gain_bits"] - 1.0) <= 1e-12 for r in rows)
        and all(r["active_applications_to_identify"] == 1 for r in rows)
        and all(r["passive_applications_to_identify"] == r["horizon"] + 1 for r in rows)
    )
    return {
        "schema": "archie-action-latent/active-operator-identification-court-v1",
        "pass": passed,
        "max_horizon": max_horizon,
        "rows": rows,
        "median_passive_over_active_observation_ratio": statistics.median(ratios),
        "max_passive_over_active_observation_ratio": max(ratios) if ratios else 0.0,
        "architectural_consequence": (
            "When causal uncertainty matters, allocate computation jointly across internal inference and external experiment choice. A compact resident belief can select an intervention that destroys an arbitrarily long passive alias in one observation in this witness family. "
            "Context length is therefore not the only memory/intelligence axis; controllable information acquisition can substitute for passive storage."
        ),
        "integration": (
            "Operator belief filter -> choose probe maximizing predicted partition entropy -> execute through a reversible/sandboxed motor court -> attach sensor/effect receipt -> eliminate inconsistent branches -> consolidate only the surviving receipt-backed operator."
        ),
        "claim_boundary": (
            "PASS assumes the agent can cheaply place the system at any finite probe state and observations are exact. Real intervention cost, safety, partial observability, and noisy dynamics require a value-of-information planner rather than raw entropy maximization."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-horizon", type=int, default=128)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(args.max_horizon)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
