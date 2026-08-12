#!/usr/bin/env python3
"""Let exact counterexamples grow the causal model family instead of being averaged away.

`operator_constraint_manifold.py` removed the need for a declared finite list of
causal hypotheses inside a known affine family.  This court breaks that family.
The learner begins with the six-parameter 2D affine assumption

    y_j = w_j0*x1 + w_j1*x2 + w_j2

and receives exact intervention/effect pairs.  If the augmented linear system
becomes inconsistent, the affine family is *falsified*.  The learner does not
hide the contradiction in a larger neural latent.  It compiles a small grammar
of degree-2 monomials, adds each candidate relation as one extra basis column,
and accepts the cheapest extension that is both exactly identifiable on train
and exactly predictive on held-out interventions.

Positive world:
    y1 = x1 - 2*x2 + 1 + 3*x1*x2
    y2 = -x1 + x2 + 2

The compiler is not told `x1*x2`; it enumerates all degree-2 monomials by
exponent tuples.  Negative world:
    y1 contains x1^3
which is outside the bounded grammar.  The correct output there is unresolved
family falsification and *no invented stable extension*.

This is a concrete hypothesis-invention rung: residual contradiction -> basis
search -> held-out court -> receipt-backed family growth.  It is not universal
program synthesis; a finite grammar is still the current prior.
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
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
MANIFOLD_PATH = HERE / "operator_constraint_manifold.py"
EVIDENCE_PATH = HERE / "evidence_gated_consolidation.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


M = load_module("archie_residual_manifold", MANIFOLD_PATH)
E = load_module("archie_residual_evidence", EVIDENCE_PATH)
Q = Fraction
NOW_NS = 1_786_500_000_000_000_000
Point = tuple[Q, Q]
Vector = tuple[Q, Q]


@dataclass(frozen=True)
class BasisExpr:
    exp_x1: int
    exp_x2: int

    @property
    def degree(self) -> int:
        return self.exp_x1 + self.exp_x2

    @property
    def text(self) -> str:
        pieces = []
        if self.exp_x1:
            pieces.append("x1" if self.exp_x1 == 1 else f"x1^{self.exp_x1}")
        if self.exp_x2:
            pieces.append("x2" if self.exp_x2 == 1 else f"x2^{self.exp_x2}")
        return "*".join(pieces) or "1"

    @property
    def description_cost(self) -> tuple[int, int, int]:
        # Lower total degree, then fewer occupied variables, then lexicographic
        # exponent preference. No semantic knowledge of the hidden world.
        occupied = int(self.exp_x1 > 0) + int(self.exp_x2 > 0)
        return (self.degree, occupied, self.exp_x1)

    def eval(self, x: Point) -> Q:
        return (x[0] ** self.exp_x1) * (x[1] ** self.exp_x2)


def grammar(total_degree: int = 2) -> list[BasisExpr]:
    # Enumerate exactly the homogeneous monomials of requested degree.
    return [BasisExpr(i, total_degree - i) for i in range(total_degree + 1)]


def affine_row(x: Point) -> list[Q]:
    return [x[0], x[1], Q(1)]


def design_row(x: Point, extra: BasisExpr | None) -> list[Q]:
    row = affine_row(x)
    if extra is not None:
        row.append(extra.eval(x))
    return row


def solve_unique(design: list[list[Q]], target: list[Q]) -> dict[str, Any]:
    if len(design) != len(target):
        raise ValueError("design/target length mismatch")
    if not design:
        return {"consistent": True, "rank": 0, "unique": False, "solution": None}
    cols = len(design[0])
    augmented = [list(row) + [value] for row, value in zip(design, target)]
    reduced, pivots = M.rref(augmented)
    # A pivot in the RHS column is an exact contradiction.
    inconsistent = any(
        all(value == 0 for value in row[:cols]) and row[cols] != 0
        for row in reduced
    )
    design_rank = M.rank(design)
    if inconsistent:
        return {"consistent": False, "rank": design_rank, "unique": False, "solution": None}
    if design_rank < cols:
        return {"consistent": True, "rank": design_rank, "unique": False, "solution": None}
    solution_by_pivot: dict[int, Q] = {}
    for row in reduced:
        pivot = next((i for i, value in enumerate(row[:cols]) if value != 0), None)
        if pivot is not None:
            solution_by_pivot[pivot] = row[cols]
    if len(solution_by_pivot) != cols:
        return {"consistent": True, "rank": design_rank, "unique": False, "solution": None}
    solution = tuple(solution_by_pivot[i] for i in range(cols))
    return {"consistent": True, "rank": design_rank, "unique": True, "solution": solution}


def predict(coeffs: tuple[Q, ...], x: Point, extra: BasisExpr | None) -> Q:
    row = design_row(x, extra)
    return sum(c * v for c, v in zip(coeffs, row))


def fit_world(samples: list[tuple[Point, Vector]], extra: BasisExpr | None) -> dict[str, Any]:
    design = [design_row(x, extra) for x, _ in samples]
    y1 = [y[0] for _, y in samples]
    y2 = [y[1] for _, y in samples]
    s1 = solve_unique(design, y1)
    s2 = solve_unique(design, y2)
    return {
        "consistent": s1["consistent"] and s2["consistent"],
        "unique": s1["unique"] and s2["unique"],
        "rank_y1": s1["rank"],
        "rank_y2": s2["rank"],
        "coeff_y1": s1["solution"],
        "coeff_y2": s2["solution"],
    }


def exact_holdout(fit: dict[str, Any], samples: list[tuple[Point, Vector]], extra: BasisExpr | None) -> bool:
    if not fit["unique"]:
        return False
    c1 = fit["coeff_y1"]
    c2 = fit["coeff_y2"]
    assert c1 is not None and c2 is not None
    return all(
        predict(c1, x, extra) == y[0] and predict(c2, x, extra) == y[1]
        for x, y in samples
    )


def qtext(v: Q) -> str:
    return f"{v.numerator}/{v.denominator}"


def coeff_text(values: tuple[Q, ...] | None) -> list[str] | None:
    return None if values is None else [qtext(v) for v in values]


def sample_points() -> list[Point]:
    return [
        (Q(-2), Q(-1)),
        (Q(-2), Q(1)),
        (Q(-1), Q(2)),
        (Q(0), Q(0)),
        (Q(0), Q(2)),
        (Q(1), Q(-2)),
        (Q(1), Q(1)),
        (Q(2), Q(-1)),
        (Q(2), Q(2)),
        (Q(3), Q(1)),
        (Q(-3), Q(2)),
        (Q(3), Q(-2)),
    ]


def quadratic_world(x: Point) -> Vector:
    x1, x2 = x
    return (
        x1 - 2 * x2 + 1 + 3 * x1 * x2,
        -x1 + x2 + 2,
    )


def cubic_world(x: Point) -> Vector:
    x1, x2 = x
    return (
        x1 - 2 * x2 + 1 + 2 * x1 ** 3,
        -x1 + x2 + 2,
    )


def executable_receipt(claim: E.Claim, payload: dict[str, Any], verifier: str) -> E.Receipt:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return E.Receipt(
        kind="executable",
        claim_hash=claim.claim_hash,
        verifier=verifier,
        artifact_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        verdict="pass",
    )


def compile_extension(world: Callable[[Point], Vector], name: str) -> dict[str, Any]:
    points = sample_points()
    train_points = points[:8]
    holdout_points = points[8:]
    train = [(x, world(x)) for x in train_points]
    holdout = [(x, world(x)) for x in holdout_points]
    base = fit_world(train, None)
    candidates: list[dict[str, Any]] = []
    for expr in grammar(2):
        fit = fit_world(train, expr)
        held = exact_holdout(fit, holdout, expr)
        candidates.append({
            "expr": expr,
            "expression": expr.text,
            "description_cost": expr.description_cost,
            "train_consistent": fit["consistent"],
            "train_unique": fit["unique"],
            "holdout_exact": held,
            "fit": fit,
        })
    winners = [row for row in candidates if row["train_consistent"] and row["train_unique"] and row["holdout_exact"]]
    winner = min(winners, key=lambda row: (row["description_cost"], row["expression"])) if winners else None

    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    affine_falsified_claim = E.Claim(name, "affine_family_falsified", str(not base["consistent"]).lower(), "causal")
    affine_payload = {
        "world": name,
        "base_consistent": base["consistent"],
        "train_points": [[qtext(v) for v in x] for x in train_points],
    }
    affine_event = memory.propose(
        affine_falsified_claim,
        executable_receipt(affine_falsified_claim, affine_payload, "residual-basis/affine-consistency"),
    )

    extension_event = None
    if winner is not None:
        fit = winner["fit"]
        value = json.dumps({
            "basis": winner["expression"],
            "coeff_y1": coeff_text(fit["coeff_y1"]),
            "coeff_y2": coeff_text(fit["coeff_y2"]),
        }, sort_keys=True, separators=(",", ":"))
        claim = E.Claim(name, "compiled_operator_family", value, "causal")
        proof = {
            "train_consistent": True,
            "train_unique": True,
            "holdout_exact": True,
            "expression": winner["expression"],
            "fit": {
                "coeff_y1": coeff_text(fit["coeff_y1"]),
                "coeff_y2": coeff_text(fit["coeff_y2"]),
            },
        }
        extension_event = memory.propose(
            claim,
            executable_receipt(claim, proof, "residual-basis/heldout-exact"),
        )
    else:
        unresolved = E.Claim(name, "compiled_operator_family", "unresolved", "causal")
        extension_event = memory.propose(unresolved, None)

    snap = memory.snapshot()
    public_candidates = [
        {
            "expression": row["expression"],
            "description_cost": list(row["description_cost"]),
            "train_consistent": row["train_consistent"],
            "train_unique": row["train_unique"],
            "holdout_exact": row["holdout_exact"],
            "coeff_y1": coeff_text(row["fit"]["coeff_y1"]),
            "coeff_y2": coeff_text(row["fit"]["coeff_y2"]),
        }
        for row in candidates
    ]
    return {
        "world": name,
        "base_affine_consistent": base["consistent"],
        "base_affine_unique": base["unique"],
        "affine_falsification_event": affine_event,
        "candidate_count": len(public_candidates),
        "candidates": public_candidates,
        "winner": None if winner is None else winner["expression"],
        "extension_event": extension_event,
        "stable_claims": snap["stable"],
        "volatile_claims": snap["volatile"],
    }


def run_court() -> dict[str, Any]:
    quadratic = compile_extension(quadratic_world, "quadratic_hidden_world")
    cubic = compile_extension(cubic_world, "cubic_hidden_world")
    q_winner = quadratic["winner"]
    q_candidates = {row["expression"]: row for row in quadratic["candidates"]}
    passed = bool(
        not quadratic["base_affine_consistent"]
        and q_winner is not None
        and q_candidates[q_winner]["train_consistent"]
        and q_candidates[q_winner]["holdout_exact"]
        and quadratic["extension_event"]["result"] == "stable"
        and not cubic["base_affine_consistent"]
        and cubic["winner"] is None
        and cubic["extension_event"]["result"] == "volatile"
        and all(not row["holdout_exact"] for row in cubic["candidates"])
    )
    return {
        "schema": "archie-action-latent/residual-basis-compiler-court-v1",
        "pass": passed,
        "quadratic_case": quadratic,
        "out_of_grammar_cubic_case": cubic,
        "architectural_consequence": (
            "A model-family contradiction becomes a productive developmental event. Preserve the exact residual, search the smallest allowed relation that restores held-out consequence prediction, and grow the causal basis only behind an executable receipt. "
            "If the grammar cannot explain the residual, remain explicitly unresolved instead of absorbing it into an opaque state."
        ),
        "recursive_next_break": (
            "Stop fixing polynomial degree in advance. Use the unresolved residual's symmetries/compositional structure to propose the next grammar production, then charge each production for description length and decision-relevant predictive gain."
        ),
        "claim_boundary": (
            "PASS demonstrates exact one-feature family growth inside a tiny rational polynomial grammar. It is not general symbolic regression, nonlinear system identification, or autonomous scientific discovery."
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
