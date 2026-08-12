#!/usr/bin/env python3
"""Replace a declared hypothesis list with an exact causal constraint manifold.

A finite branch list is already better than averaging incompatible operators,
but it still assumes someone handed the agent the candidate causes.  This court
removes that assumption for one nontrivial family: unknown 2D affine dynamics

    y = A x + b

with six unknown rational parameters.  Each observed intervention contributes
two linear constraints.  The resident causal state is the row-reduced constraint
system itself: rank says how many parameter distinctions have been earned;
nullity says how much operator identity remains unresolved.

The active planner does not maximize entropy over named hypotheses.  It chooses
a safe probe whose *design rows* increase exact parameter rank the most per unit
cost.  Three non-collinear probes identify the six-parameter operator exactly.
Repeated or collinear probes cannot hallucinate the missing dimensions; the
system remains an affine family and refuses durable identity consolidation.

This is a small but important recursion step:

    named hypotheses -> algebraic hypothesis manifold -> active rank acquisition

The next break is to learn the operator basis itself when the true dynamics are
outside the current affine family, using residual structure to spawn new basis
functions rather than silently fitting noise.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
EVIDENCE_PATH = HERE / "evidence_gated_consolidation.py"


def load_evidence():
    spec = importlib.util.spec_from_file_location("archie_constraint_evidence", EVIDENCE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {EVIDENCE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


E = load_evidence()
Q = Fraction
NOW_NS = 1_786_500_000_000_000_000


@dataclass(frozen=True)
class Probe:
    name: str
    x: tuple[Q, Q]
    cost: Q
    risk: Q
    reversible: bool = True


@dataclass(frozen=True)
class HiddenAffine:
    # theta = [a11, a12, b1, a21, a22, b2]
    theta: tuple[Q, Q, Q, Q, Q, Q]

    def apply(self, x: tuple[Q, Q]) -> tuple[Q, Q]:
        a11, a12, b1, a21, a22, b2 = self.theta
        x1, x2 = x
        return (a11 * x1 + a12 * x2 + b1, a21 * x1 + a22 * x2 + b2)


def observation_rows(x: tuple[Q, Q], y: tuple[Q, Q]) -> list[list[Q]]:
    x1, x2 = x
    y1, y2 = y
    # augmented rows for six parameters plus RHS
    return [
        [x1, x2, Q(1), Q(0), Q(0), Q(0), y1],
        [Q(0), Q(0), Q(0), x1, x2, Q(1), y2],
    ]


def design_rows(x: tuple[Q, Q]) -> list[list[Q]]:
    x1, x2 = x
    return [
        [x1, x2, Q(1), Q(0), Q(0), Q(0)],
        [Q(0), Q(0), Q(0), x1, x2, Q(1)],
    ]


def rref(matrix: Iterable[Iterable[Q]]) -> tuple[list[list[Q]], list[int]]:
    a = [list(map(Q, row)) for row in matrix]
    if not a:
        return [], []
    rows, cols = len(a), len(a[0])
    pivot_cols: list[int] = []
    r = 0
    for c in range(cols):
        pivot = next((i for i in range(r, rows) if a[i][c] != 0), None)
        if pivot is None:
            continue
        a[r], a[pivot] = a[pivot], a[r]
        scale = a[r][c]
        a[r] = [v / scale for v in a[r]]
        for i in range(rows):
            if i == r or a[i][c] == 0:
                continue
            factor = a[i][c]
            a[i] = [left - factor * right for left, right in zip(a[i], a[r])]
        pivot_cols.append(c)
        r += 1
        if r == rows:
            break
    # canonical zero-row ordering makes receipts stable
    nonzero = [row for row in a if any(v != 0 for v in row)]
    zero = [row for row in a if not any(v != 0 for v in row)]
    return nonzero + zero, pivot_cols


def rank(matrix: Iterable[Iterable[Q]]) -> int:
    rows = [list(row) for row in matrix]
    if not rows:
        return 0
    _, pivots = rref(rows)
    return len(pivots)


def frac_text(v: Q) -> str:
    return f"{v.numerator}/{v.denominator}"


def vector_text(values: Iterable[Q]) -> list[str]:
    return [frac_text(Q(v)) for v in values]


class ConstraintManifold:
    PARAMS = 6

    def __init__(self):
        self.rows: list[list[Q]] = []  # augmented 6+1
        self.observations: list[dict[str, Any]] = []

    @property
    def design(self) -> list[list[Q]]:
        return [row[: self.PARAMS] for row in self.rows]

    @property
    def rank(self) -> int:
        return rank(self.design)

    @property
    def nullity(self) -> int:
        return self.PARAMS - self.rank

    def rank_gain(self, x: tuple[Q, Q]) -> int:
        return rank([*self.design, *design_rows(x)]) - self.rank

    def observe(self, probe: Probe, y: tuple[Q, Q]) -> dict[str, Any]:
        before = self.rank
        self.rows.extend(observation_rows(probe.x, y))
        after = self.rank
        event = {
            "probe": probe.name,
            "x": vector_text(probe.x),
            "y": vector_text(y),
            "rank_before": before,
            "rank_after": after,
            "rank_gain": after - before,
            "nullity_after": self.nullity,
        }
        self.observations.append(event)
        return event

    def unique_solution(self) -> tuple[Q, ...] | None:
        if self.rank != self.PARAMS:
            return None
        reduced, pivots = rref(self.rows)
        # An inconsistent row 0...0 | nonzero would falsify the affine family.
        for row in reduced:
            if all(v == 0 for v in row[: self.PARAMS]) and row[self.PARAMS] != 0:
                return None
        if not all(i in pivots for i in range(self.PARAMS)):
            return None
        by_pivot: dict[int, Q] = {}
        for row in reduced:
            pivot = next((i for i, v in enumerate(row[: self.PARAMS]) if v != 0), None)
            if pivot is not None:
                by_pivot[pivot] = row[self.PARAMS]
        if len(by_pivot) != self.PARAMS:
            return None
        return tuple(by_pivot[i] for i in range(self.PARAMS))

    def receipt_payload(self) -> dict[str, Any]:
        reduced, pivots = rref(self.rows)
        return {
            "schema": "archie/affine-constraint-manifold-v1",
            "rank": self.rank,
            "nullity": self.nullity,
            "pivot_columns": pivots,
            "rref": [[frac_text(v) for v in row] for row in reduced],
            "observations": list(self.observations),
        }


def choose_probe(
    manifold: ConstraintManifold,
    probes: list[Probe],
    *,
    risk_limit: Q,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for probe in probes:
        gain = manifold.rank_gain(probe.x)
        safe = probe.reversible and probe.risk <= risk_limit
        # Exact rational priority: first gain, then gain/cost, then lower risk.
        efficiency = Q(gain, 1) / max(probe.cost, Q(1, 10_000))
        rows.append({
            "probe": probe,
            "rank_gain": gain,
            "safe": safe,
            "efficiency": efficiency,
        })
    eligible = [row for row in rows if row["safe"] and row["rank_gain"] > 0]
    selected = max(
        eligible,
        key=lambda row: (row["rank_gain"], row["efficiency"], -row["probe"].risk, row["probe"].name),
    ) if eligible else None
    return {
        "selected": selected,
        "candidates": rows,
        "disposition": "probe" if selected else "preserve_manifold",
    }


def stable_operator_claim(manifold: ConstraintManifold, memory: E.EvidenceGatedMemory) -> dict[str, Any]:
    solution = manifold.unique_solution()
    if solution is None:
        claim = E.Claim(
            "unknown_affine_operator",
            "parameter_nullity",
            str(manifold.nullity),
            "causal",
        )
        event = memory.propose(claim, None)
        return {"stable": False, "solution": None, "memory_event": event}

    value = ",".join(vector_text(solution))
    claim = E.Claim("unknown_affine_operator", "parameters", value, "causal")
    payload = manifold.receipt_payload()
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    receipt = E.Receipt(
        kind="sensor",
        claim_hash=claim.claim_hash,
        verifier="affine-constraint-rref-court",
        artifact_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        verdict="pass",
        issued_ns=NOW_NS - 10,
        expires_ns=NOW_NS + 10_000,
    )
    event = memory.propose(claim, receipt)
    return {"stable": event["result"] == "stable", "solution": vector_text(solution), "memory_event": event}


def run_identifiable_case() -> dict[str, Any]:
    hidden = HiddenAffine((Q(0), Q(-1), Q(2), Q(1), Q(0), Q(-1)))
    manifold = ConstraintManifold()
    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    probes = [
        Probe("origin", (Q(0), Q(0)), Q(1, 10), Q(1, 100)),
        Probe("repeat_origin", (Q(0), Q(0)), Q(1, 100), Q(1, 100)),
        Probe("x_axis", (Q(1), Q(0)), Q(1, 5), Q(1, 100)),
        Probe("y_axis", (Q(0), Q(1)), Q(1, 4), Q(1, 100)),
        Probe("unsafe_far", (Q(7), Q(11)), Q(0), Q(9, 10), False),
    ]
    trace: list[dict[str, Any]] = []
    for _ in range(3):
        plan = choose_probe(manifold, probes, risk_limit=Q(1, 5))
        selected = plan["selected"]
        if selected is None:
            break
        probe = selected["probe"]
        obs = manifold.observe(probe, hidden.apply(probe.x))
        trace.append({
            "selected": probe.name,
            "planned_rank_gain": selected["rank_gain"],
            "observed": obs,
        })
        # A probe may be reused only if it can still add rank; choose_probe will
        # automatically give it zero gain after its design rows are absorbed.
    consolidation = stable_operator_claim(manifold, memory)
    solution = manifold.unique_solution()
    return {
        "trace": trace,
        "final_rank": manifold.rank,
        "final_nullity": manifold.nullity,
        "solution": vector_text(solution) if solution else None,
        "hidden": vector_text(hidden.theta),
        "exact_recovery": solution == hidden.theta,
        "consolidation": consolidation,
        "stable_count": len(memory.snapshot()["stable"]),
    }


def run_collinear_case() -> dict[str, Any]:
    hidden = HiddenAffine((Q(2), Q(3), Q(5), Q(-1), Q(4), Q(7)))
    manifold = ConstraintManifold()
    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    probes = [
        Probe("line0", (Q(0), Q(0)), Q(1, 10), Q(1, 100)),
        Probe("line1", (Q(1), Q(0)), Q(1, 10), Q(1, 100)),
        Probe("line2", (Q(2), Q(0)), Q(1, 10), Q(1, 100)),
        Probe("unsafe_offline", (Q(0), Q(1)), Q(0), Q(9, 10), False),
    ]
    trace: list[dict[str, Any]] = []
    for _ in range(4):
        plan = choose_probe(manifold, probes, risk_limit=Q(1, 5))
        selected = plan["selected"]
        if selected is None:
            trace.append({"disposition": plan["disposition"]})
            break
        probe = selected["probe"]
        trace.append(manifold.observe(probe, hidden.apply(probe.x)))
    consolidation = stable_operator_claim(manifold, memory)
    return {
        "trace": trace,
        "final_rank": manifold.rank,
        "final_nullity": manifold.nullity,
        "unique_solution": manifold.unique_solution() is not None,
        "consolidation": consolidation,
        "stable_count": len(memory.snapshot()["stable"]),
        "volatile_count": sum(len(v) for v in memory.snapshot()["volatile"].values()),
    }


def run_court() -> dict[str, Any]:
    identifiable = run_identifiable_case()
    collinear = run_collinear_case()
    passed = bool(
        identifiable["final_rank"] == 6
        and identifiable["final_nullity"] == 0
        and identifiable["exact_recovery"]
        and identifiable["consolidation"]["stable"]
        and identifiable["stable_count"] == 1
        and collinear["final_rank"] == 4
        and collinear["final_nullity"] == 2
        and not collinear["unique_solution"]
        and not collinear["consolidation"]["stable"]
        and collinear["stable_count"] == 0
        and collinear["volatile_count"] >= 1
    )
    return {
        "schema": "archie-action-latent/operator-constraint-manifold-court-v1",
        "pass": passed,
        "identifiable_case": identifiable,
        "collinear_underdetermined_case": collinear,
        "architectural_consequence": (
            "Causal uncertainty need not be a finite list of named branches. For structured operator families it can be a compact exact constraint manifold whose rank/nullity measures earned distinguishability. "
            "Active experiments target missing dimensions; durable identity appears only when the manifold collapses to a receipt-backed singleton."
        ),
        "recursive_next_break": (
            "Adversarially violate the affine family. When exact constraints become inconsistent, retain the falsification residual and compile the smallest new basis function that restores predictive sufficiency across held-out interventions. "
            "That is the path from hypothesis selection toward hypothesis invention."
        ),
        "claim_boundary": (
            "PASS establishes exact rational system identification only for 2D affine maps with directly chosen state probes. It does not solve nonlinear basis discovery, partial observability, noisy sensing, or safe real-world experiment design."
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
