#!/usr/bin/env python3
"""Falsification-driven model-order growth with an explicit stop condition.

`residual_basis_compiler.py` proved one useful rung: an affine causal family can
be falsified exactly, and one missing degree-2 relation can be compiled from a
small grammar.  It still fixed the grammar order by hand.  This court removes
that handoff.

The learner begins at total polynomial degree 1.  For each degree d it:

  1. builds every 2D monomial x1^i x2^j with i+j <= d;
  2. solves the two output maps exactly over rational training interventions;
  3. requires a unique exact fit, not least-squares plausibility;
  4. verifies every held-out intervention exactly;
  5. stops at the first degree that survives the court;
  6. only then allows receipt-backed durable consolidation.

Quadratic, cubic, and quartic hidden worlds should therefore stabilize at
minimal degrees 2, 3, and 4 without a human announcing which grammar to try.
A rational hidden world is intentionally outside the degree<=4 language.  It
must remain unresolved rather than being promoted from interpolation on the
training set.

This is still a bounded grammar ladder, not general science.  The recursion is
important: a failed family now changes the hypothesis language itself; a failed
maximum order remains a first-class counterexample for the next grammar
production rather than becoming opaque neural error.
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
from typing import Any, Callable, Iterable

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


M = load_module("archie_expanding_poly_manifold", MANIFOLD_PATH)
E = load_module("archie_expanding_poly_evidence", EVIDENCE_PATH)
Q = Fraction
NOW_NS = 1_786_500_000_000_000_000
Point = tuple[Q, Q]
Vector = tuple[Q, Q]


@dataclass(frozen=True, order=True)
class Monomial:
    exp_x1: int
    exp_x2: int

    @property
    def degree(self) -> int:
        return self.exp_x1 + self.exp_x2

    @property
    def text(self) -> str:
        if self.exp_x1 == 0 and self.exp_x2 == 0:
            return "1"
        parts: list[str] = []
        if self.exp_x1:
            parts.append("x1" if self.exp_x1 == 1 else f"x1^{self.exp_x1}")
        if self.exp_x2:
            parts.append("x2" if self.exp_x2 == 1 else f"x2^{self.exp_x2}")
        return "*".join(parts)

    def eval(self, x: Point) -> Q:
        return x[0] ** self.exp_x1 * x[1] ** self.exp_x2


def basis_up_to(degree: int) -> list[Monomial]:
    if degree < 0:
        raise ValueError("degree must be non-negative")
    # Constant first, then degree, then x1 exponent. Stable order is part of the
    # receipt so a promoted family can be reconstructed exactly.
    out: list[Monomial] = []
    for total in range(degree + 1):
        for i in range(total + 1):
            out.append(Monomial(i, total - i))
    return out


def design_row(x: Point, basis: list[Monomial]) -> list[Q]:
    return [term.eval(x) for term in basis]


def solve_exact(design: list[list[Q]], target: list[Q]) -> dict[str, Any]:
    if not design or len(design) != len(target):
        raise ValueError("non-empty matched design/target required")
    cols = len(design[0])
    augmented = [list(row) + [y] for row, y in zip(design, target)]
    reduced, _ = M.rref(augmented)
    inconsistent = any(
        all(value == 0 for value in row[:cols]) and row[cols] != 0
        for row in reduced
    )
    design_rank = M.rank(design)
    if inconsistent:
        return {"consistent": False, "rank": design_rank, "unique": False, "solution": None}
    if design_rank != cols:
        return {"consistent": True, "rank": design_rank, "unique": False, "solution": None}
    by_pivot: dict[int, Q] = {}
    for row in reduced:
        pivot = next((i for i, v in enumerate(row[:cols]) if v != 0), None)
        if pivot is not None:
            by_pivot[pivot] = row[cols]
    if len(by_pivot) != cols:
        return {"consistent": True, "rank": design_rank, "unique": False, "solution": None}
    return {
        "consistent": True,
        "rank": design_rank,
        "unique": True,
        "solution": tuple(by_pivot[i] for i in range(cols)),
    }


def fit(samples: list[tuple[Point, Vector]], degree: int) -> dict[str, Any]:
    basis = basis_up_to(degree)
    design = [design_row(x, basis) for x, _ in samples]
    s1 = solve_exact(design, [y[0] for _, y in samples])
    s2 = solve_exact(design, [y[1] for _, y in samples])
    return {
        "degree": degree,
        "basis": basis,
        "consistent": s1["consistent"] and s2["consistent"],
        "unique": s1["unique"] and s2["unique"],
        "rank_y1": s1["rank"],
        "rank_y2": s2["rank"],
        "coeff_y1": s1["solution"],
        "coeff_y2": s2["solution"],
    }


def predict(coeffs: tuple[Q, ...], x: Point, basis: list[Monomial]) -> Q:
    return sum(c * term.eval(x) for c, term in zip(coeffs, basis))


def holdout_exact(model: dict[str, Any], samples: list[tuple[Point, Vector]]) -> bool:
    if not model["unique"]:
        return False
    c1 = model["coeff_y1"]
    c2 = model["coeff_y2"]
    assert c1 is not None and c2 is not None
    basis = model["basis"]
    return all(
        predict(c1, x, basis) == y[0] and predict(c2, x, basis) == y[1]
        for x, y in samples
    )


def qtext(value: Q) -> str:
    return f"{value.numerator}/{value.denominator}"


def coeff_text(values: tuple[Q, ...] | None) -> list[str] | None:
    return None if values is None else [qtext(v) for v in values]


def point_corpus() -> list[Point]:
    # 40 deterministic integer points. We later pick a rank-complete training
    # subset for the max degree, rather than trusting a rectangular slice to be
    # unisolvent for every monomial basis.
    raw: list[Point] = []
    for x1 in range(-4, 5):
        for x2 in range(-4, 5):
            if (x1, x2) == (0, 0) or (3 * x1 + 5 * x2) % 4 != 0:
                raw.append((Q(x1), Q(x2)))
    return raw


def choose_rank_complete_points(max_degree: int, train_count: int) -> tuple[list[Point], list[Point]]:
    basis = basis_up_to(max_degree)
    candidates = point_corpus()
    train: list[Point] = []
    rows: list[list[Q]] = []
    current_rank = 0
    # First greedily buy rank, then add extra overdetermining points. Exact
    # consistency on extra points prevents a degree-d fit from passing merely
    # because it had exactly as many equations as coefficients.
    remaining: list[Point] = []
    for point in candidates:
        candidate_row = design_row(point, basis)
        new_rank = M.rank([*rows, candidate_row])
        if new_rank > current_rank:
            train.append(point)
            rows.append(candidate_row)
            current_rank = new_rank
        else:
            remaining.append(point)
        if current_rank == len(basis):
            break
    used = set(train)
    remaining = [p for p in candidates if p not in used]
    if current_rank != len(basis):
        raise RuntimeError(f"could not build rank-complete degree {max_degree} design")
    for point in remaining:
        if len(train) >= train_count:
            break
        train.append(point)
    holdout = [p for p in candidates if p not in set(train)]
    if len(train) < train_count or len(holdout) < 8:
        raise RuntimeError("insufficient train/holdout corpus")
    return train, holdout


def quadratic_world(x: Point) -> Vector:
    x1, x2 = x
    return (Q(2) + x1 - 2 * x2 + 3 * x1 * x2, Q(-1) + 2 * x1 + x2 * x2)


def cubic_world(x: Point) -> Vector:
    x1, x2 = x
    return (Q(1) - x2 + 2 * x1 ** 3 + x1 * x2, Q(3) + x1 - 2 * x2 + x1 * x2 * x2)


def quartic_world(x: Point) -> Vector:
    x1, x2 = x
    return (Q(-2) + x1 + x2 + x1 ** 2 * x2 ** 2, Q(5) - x1 + 2 * x2 + 2 * x1 ** 4)


def rational_world(x: Point) -> Vector:
    x1, x2 = x
    return (Q(1, 1 + x1 * x1) + x2, x1 + Q(1, 1 + x2 * x2))


def executable_receipt(claim: E.Claim, payload: dict[str, Any], verifier: str) -> E.Receipt:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return E.Receipt(
        kind="executable",
        claim_hash=claim.claim_hash,
        verifier=verifier,
        artifact_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        verdict="pass",
    )


def compile_world(
    name: str,
    world: Callable[[Point], Vector],
    *,
    max_degree: int,
    train_points: list[Point],
    holdout_points: list[Point],
) -> dict[str, Any]:
    train = [(x, world(x)) for x in train_points]
    holdout = [(x, world(x)) for x in holdout_points]
    ladder: list[dict[str, Any]] = []
    winner: dict[str, Any] | None = None
    for degree in range(1, max_degree + 1):
        model = fit(train, degree)
        exact = holdout_exact(model, holdout)
        row = {
            "degree": degree,
            "basis_size": len(model["basis"]),
            "train_consistent": model["consistent"],
            "train_unique": model["unique"],
            "rank_y1": model["rank_y1"],
            "rank_y2": model["rank_y2"],
            "holdout_exact": exact,
            "basis": [term.text for term in model["basis"]],
            "coeff_y1": coeff_text(model["coeff_y1"]),
            "coeff_y2": coeff_text(model["coeff_y2"]),
        }
        ladder.append(row)
        if model["consistent"] and model["unique"] and exact:
            winner = row
            break

    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    if winner is None:
        claim = E.Claim(name, "compiled_polynomial_family", f"unresolved_through_degree_{max_degree}", "causal")
        event = memory.propose(claim, None)
    else:
        value = json.dumps(
            {
                "minimal_degree": winner["degree"],
                "basis": winner["basis"],
                "coeff_y1": winner["coeff_y1"],
                "coeff_y2": winner["coeff_y2"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        claim = E.Claim(name, "compiled_polynomial_family", value, "causal")
        proof = {
            "minimal_degree": winner["degree"],
            "train_points": [[qtext(v) for v in x] for x in train_points],
            "holdout_points": [[qtext(v) for v in x] for x in holdout_points],
            "winning_model": winner,
            "all_lower_degrees_failed": all(not row["holdout_exact"] for row in ladder[:-1]),
        }
        event = memory.propose(
            claim,
            executable_receipt(claim, proof, "self-expanding-polynomial/heldout-exact"),
        )
    snap = memory.snapshot()
    return {
        "world": name,
        "ladder": ladder,
        "winner_degree": None if winner is None else winner["degree"],
        "promotion_event": event,
        "stable_count": len(snap["stable"]),
        "volatile_count": sum(len(rows) for rows in snap["volatile"].values()),
    }


def run_court(max_degree: int = 4) -> dict[str, Any]:
    basis_size = len(basis_up_to(max_degree))
    train_points, holdout_points = choose_rank_complete_points(max_degree, basis_size + 8)
    cases = {
        "quadratic": compile_world("quadratic_world", quadratic_world, max_degree=max_degree, train_points=train_points, holdout_points=holdout_points),
        "cubic": compile_world("cubic_world", cubic_world, max_degree=max_degree, train_points=train_points, holdout_points=holdout_points),
        "quartic": compile_world("quartic_world", quartic_world, max_degree=max_degree, train_points=train_points, holdout_points=holdout_points),
        "rational": compile_world("rational_world", rational_world, max_degree=max_degree, train_points=train_points, holdout_points=holdout_points),
    }
    passed = bool(
        cases["quadratic"]["winner_degree"] == 2
        and cases["cubic"]["winner_degree"] == 3
        and cases["quartic"]["winner_degree"] == 4
        and cases["rational"]["winner_degree"] is None
        and all(cases[name]["promotion_event"]["result"] == "stable" for name in ("quadratic", "cubic", "quartic"))
        and cases["rational"]["promotion_event"]["result"] == "volatile"
        and cases["rational"]["stable_count"] == 0
    )
    return {
        "schema": "archie-action-latent/self-expanding-polynomial-grammar-v1",
        "pass": passed,
        "max_degree": max_degree,
        "max_basis_size": basis_size,
        "train_point_count": len(train_points),
        "holdout_point_count": len(holdout_points),
        "cases": cases,
        "architectural_consequence": (
            "Model order is no longer a human-selected switch in this court. Exact falsification grows the causal language one rung at a time, and only the first held-out-exact family can harden into memory. The resident system can therefore stay structurally small until evidence forces a larger hypothesis language."
        ),
        "recursive_next_break": (
            "The remaining fixed object is 'polynomial'. Use unresolved rational residuals to synthesize grammar productions such as reciprocal/composition operators from residual invariants, then compete those productions under description length, intervention cost, and decision regret."
        ),
        "claim_boundary": (
            "PASS establishes minimal total-degree selection only for exact rational 2D polynomial maps through the configured degree. It does not solve sparse basis selection, noise, rational/transcendental discovery, or general program induction."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-degree", type=int, default=4)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(args.max_degree)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
