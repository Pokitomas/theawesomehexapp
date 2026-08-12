#!/usr/bin/env python3
"""Use unresolved exact residuals to search a compositional expression grammar.

The polynomial model-order ladder still bakes in one hypothesis language.  This
court starts from the same affine core but lets a failed polynomial/rational
residual search a tiny *compositional* grammar over observed coordinates:

    atoms: 1, x1, x2
    productions: add(a,b), mul(a,b), inv(a)

Expressions are enumerated by description cost, evaluated exactly with rational
arithmetic, and deduplicated by their value signature on the training corpus.
For each output, the compiler asks whether affine terms plus one synthesized
expression give a unique exact training solution and exact held-out prediction.
The first cheapest expression that survives becomes eligible for durable
consolidation.

The positive hidden world contains `1/(1+x1^2)` and `1/(1+x2^2)`.  Those strings
are never listed as candidates; they must be produced by grammar closure.  A
harder world uses `1/(1+x^3)`, whose cheapest construction exceeds the configured
cost budget.  It must remain unresolved rather than being hallucinated from an
approximate polynomial fit.

This is a bounded symbolic-production court, not general program synthesis.  Its
purpose is recursive architecture pressure: once model order itself learned to
grow, the next fixed object—the grammar—also becomes falsifiable and extensible.
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


M = load_module("archie_residual_grammar_manifold", MANIFOLD_PATH)
E = load_module("archie_residual_grammar_evidence", EVIDENCE_PATH)
Q = Fraction
NOW_NS = 1_786_500_000_000_000_000
Point = tuple[Q, Q]
Vector = tuple[Q, Q]


@dataclass(frozen=True)
class Expr:
    op: str
    args: tuple["Expr", ...] = ()
    atom: str = ""
    cost: int = 1

    @property
    def text(self) -> str:
        if self.op == "atom":
            return self.atom
        if self.op == "inv":
            return f"inv({self.args[0].text})"
        symbol = "+" if self.op == "add" else "*"
        return f"({self.args[0].text}{symbol}{self.args[1].text})"

    def eval(self, x: Point) -> Q | None:
        if self.op == "atom":
            if self.atom == "1":
                return Q(1)
            if self.atom == "x1":
                return x[0]
            if self.atom == "x2":
                return x[1]
            raise ValueError(self.atom)
        if self.op == "inv":
            value = self.args[0].eval(x)
            if value is None or value == 0:
                return None
            return Q(1, 1) / value
        left = self.args[0].eval(x)
        right = self.args[1].eval(x)
        if left is None or right is None:
            return None
        return left + right if self.op == "add" else left * right


def atom(name: str) -> Expr:
    return Expr("atom", atom=name, cost=1)


def unary_inv(child: Expr) -> Expr:
    return Expr("inv", args=(child,), cost=1 + child.cost)


def binary(op: str, left: Expr, right: Expr) -> Expr:
    # Canonicalize commutative productions so the grammar does not pay twice for
    # x1*x2 and x2*x1.
    if right.text < left.text:
        left, right = right, left
    return Expr(op, args=(left, right), cost=1 + left.cost + right.cost)


def points() -> list[Point]:
    return [
        (Q(-4), Q(-3)), (Q(-4), Q(1)), (Q(-3), Q(-2)), (Q(-3), Q(2)),
        (Q(-2), Q(-4)), (Q(-2), Q(-1)), (Q(-2), Q(3)), (Q(-1), Q(-3)),
        (Q(-1), Q(1)), (Q(-1), Q(4)), (Q(0), Q(-4)), (Q(0), Q(-1)),
        (Q(0), Q(2)), (Q(1), Q(-2)), (Q(1), Q(1)), (Q(1), Q(4)),
        (Q(2), Q(-3)), (Q(2), Q(0)), (Q(2), Q(3)), (Q(3), Q(-4)),
        (Q(3), Q(-1)), (Q(3), Q(2)), (Q(4), Q(-2)), (Q(4), Q(1)),
        (Q(4), Q(4)),
    ]


def signature(expr: Expr, corpus: list[Point]) -> tuple[Q, ...] | None:
    values: list[Q] = []
    for x in corpus:
        value = expr.eval(x)
        if value is None:
            return None
        values.append(value)
    return tuple(values)


def enumerate_grammar(max_cost: int, corpus: list[Point]) -> list[Expr]:
    by_cost: dict[int, list[Expr]] = {1: [atom("1"), atom("x1"), atom("x2")]}
    seen_text = {expr.text for expr in by_cost[1]}
    best_by_signature: dict[tuple[Q, ...], Expr] = {}
    for expr in by_cost[1]:
        sig = signature(expr, corpus)
        if sig is not None:
            best_by_signature[sig] = expr

    for cost in range(2, max_cost + 1):
        candidates: list[Expr] = []
        # inv(child) adds one node.
        for child in by_cost.get(cost - 1, []):
            candidates.append(unary_inv(child))
        # binary op adds one node.
        for left_cost in range(1, cost - 1):
            right_cost = cost - 1 - left_cost
            if right_cost < 1:
                continue
            for left in by_cost.get(left_cost, []):
                for right in by_cost.get(right_cost, []):
                    candidates.append(binary("add", left, right))
                    candidates.append(binary("mul", left, right))

        accepted: list[Expr] = []
        for expr in sorted(candidates, key=lambda e: e.text):
            if expr.cost != cost or expr.text in seen_text:
                continue
            seen_text.add(expr.text)
            sig = signature(expr, corpus)
            if sig is None:
                continue
            old = best_by_signature.get(sig)
            if old is not None and (old.cost, old.text) <= (expr.cost, expr.text):
                continue
            best_by_signature[sig] = expr
            accepted.append(expr)
        by_cost[cost] = accepted

    # Re-deduplicate in case a cheaper signature discovered later invalidated a
    # stored expression. Return only the canonical cheapest representative.
    canonical = {expr.text: expr for expr in best_by_signature.values()}
    return sorted(canonical.values(), key=lambda e: (e.cost, e.text))


def design_row(x: Point, extra: Expr | None) -> list[Q] | None:
    row = [Q(1), x[0], x[1]]
    if extra is not None:
        value = extra.eval(x)
        if value is None:
            return None
        row.append(value)
    return row


def solve_exact(rows: list[list[Q]], target: list[Q]) -> dict[str, Any]:
    cols = len(rows[0])
    augmented = [list(row) + [y] for row, y in zip(rows, target)]
    reduced, _ = M.rref(augmented)
    inconsistent = any(
        all(value == 0 for value in row[:cols]) and row[cols] != 0
        for row in reduced
    )
    design_rank = M.rank(rows)
    if inconsistent or design_rank != cols:
        return {"consistent": not inconsistent, "unique": False, "rank": design_rank, "solution": None}
    solution_by_pivot: dict[int, Q] = {}
    for row in reduced:
        pivot = next((i for i, value in enumerate(row[:cols]) if value != 0), None)
        if pivot is not None:
            solution_by_pivot[pivot] = row[cols]
    if len(solution_by_pivot) != cols:
        return {"consistent": True, "unique": False, "rank": design_rank, "solution": None}
    return {
        "consistent": True,
        "unique": True,
        "rank": design_rank,
        "solution": tuple(solution_by_pivot[i] for i in range(cols)),
    }


def fit_output(train: list[tuple[Point, Vector]], output_index: int, expr: Expr | None) -> dict[str, Any]:
    rows: list[list[Q]] = []
    for x, _ in train:
        row = design_row(x, expr)
        if row is None:
            return {"consistent": False, "unique": False, "rank": 0, "solution": None}
        rows.append(row)
    return solve_exact(rows, [y[output_index] for _, y in train])


def predict(solution: tuple[Q, ...], x: Point, expr: Expr | None) -> Q | None:
    row = design_row(x, expr)
    if row is None:
        return None
    return sum(c * v for c, v in zip(solution, row))


def exact_holdout(
    fit: dict[str, Any],
    holdout: list[tuple[Point, Vector]],
    output_index: int,
    expr: Expr | None,
) -> bool:
    solution = fit.get("solution")
    if not fit.get("unique") or solution is None:
        return False
    return all(predict(solution, x, expr) == y[output_index] for x, y in holdout)


def qtext(v: Q) -> str:
    return f"{v.numerator}/{v.denominator}"


def coeff_text(solution: tuple[Q, ...] | None) -> list[str] | None:
    return None if solution is None else [qtext(v) for v in solution]


def rational_square_world(x: Point) -> Vector:
    x1, x2 = x
    return (x2 + Q(1, 1 + x1 * x1), x1 + Q(1, 1 + x2 * x2))


def rational_cubic_world(x: Point) -> Vector:
    x1, x2 = x
    return (x2 + Q(1, 1 + x1 ** 3), x1 + Q(1, 1 + x2 ** 3))


def compile_output(
    train: list[tuple[Point, Vector]],
    holdout: list[tuple[Point, Vector]],
    output_index: int,
    expressions: list[Expr],
) -> dict[str, Any]:
    base = fit_output(train, output_index, None)
    if exact_holdout(base, holdout, output_index, None):
        return {"expression": None, "cost": 0, "fit": base, "holdout_exact": True, "tested": 0}
    tested = 0
    for expr in expressions:
        # Affine atoms/signature duplicates are harmless but waste courts; only
        # inspect expressions with actual compositional structure.
        if expr.cost <= 1:
            continue
        tested += 1
        model = fit_output(train, output_index, expr)
        if model["consistent"] and model["unique"] and exact_holdout(model, holdout, output_index, expr):
            return {
                "expression": expr.text,
                "cost": expr.cost,
                "fit": model,
                "holdout_exact": True,
                "tested": tested,
            }
    return {"expression": None, "cost": None, "fit": None, "holdout_exact": False, "tested": tested}


def receipt_for(claim: E.Claim, payload: dict[str, Any]) -> E.Receipt:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return E.Receipt(
        kind="executable",
        claim_hash=claim.claim_hash,
        verifier="residual-grammar/heldout-exact",
        artifact_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        verdict="pass",
    )


def compile_world(name: str, world: Callable[[Point], Vector], *, max_cost: int) -> dict[str, Any]:
    corpus = points()
    train_points = corpus[:17]
    holdout_points = corpus[17:]
    train = [(x, world(x)) for x in train_points]
    holdout = [(x, world(x)) for x in holdout_points]
    expressions = enumerate_grammar(max_cost, train_points)
    out1 = compile_output(train, holdout, 0, expressions)
    out2 = compile_output(train, holdout, 1, expressions)
    solved = out1["holdout_exact"] and out2["holdout_exact"]

    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    if solved:
        payload = {
            "max_cost": max_cost,
            "grammar_expression_count": len(expressions),
            "output1": {
                "expression": out1["expression"],
                "cost": out1["cost"],
                "coefficients": coeff_text(out1["fit"]["solution"]),
            },
            "output2": {
                "expression": out2["expression"],
                "cost": out2["cost"],
                "coefficients": coeff_text(out2["fit"]["solution"]),
            },
        }
        claim = E.Claim(name, "compiled_expression_family", json.dumps(payload, sort_keys=True, separators=(",", ":")), "causal")
        event = memory.propose(claim, receipt_for(claim, payload))
    else:
        claim = E.Claim(name, "compiled_expression_family", f"unresolved_cost_le_{max_cost}", "causal")
        event = memory.propose(claim, None)
    snap = memory.snapshot()
    return {
        "world": name,
        "max_cost": max_cost,
        "grammar_expression_count": len(expressions),
        "output1": {
            "expression": out1["expression"], "cost": out1["cost"],
            "holdout_exact": out1["holdout_exact"], "tested": out1["tested"],
            "coefficients": None if out1["fit"] is None else coeff_text(out1["fit"]["solution"]),
        },
        "output2": {
            "expression": out2["expression"], "cost": out2["cost"],
            "holdout_exact": out2["holdout_exact"], "tested": out2["tested"],
            "coefficients": None if out2["fit"] is None else coeff_text(out2["fit"]["solution"]),
        },
        "promotion_event": event,
        "stable_count": len(snap["stable"]),
        "volatile_count": sum(len(rows) for rows in snap["volatile"].values()),
    }


def run_court(max_cost: int = 6) -> dict[str, Any]:
    square = compile_world("rational_square_world", rational_square_world, max_cost=max_cost)
    cubic = compile_world("rational_cubic_world", rational_cubic_world, max_cost=max_cost)
    passed = bool(
        square["output1"]["holdout_exact"]
        and square["output2"]["holdout_exact"]
        and square["output1"]["cost"] is not None
        and square["output2"]["cost"] is not None
        and square["output1"]["cost"] <= max_cost
        and square["output2"]["cost"] <= max_cost
        and square["promotion_event"]["result"] == "stable"
        and not cubic["output1"]["holdout_exact"]
        and not cubic["output2"]["holdout_exact"]
        and cubic["promotion_event"]["result"] == "volatile"
        and cubic["stable_count"] == 0
    )
    return {
        "schema": "archie-action-latent/residual-grammar-production-search-v1",
        "pass": passed,
        "max_cost": max_cost,
        "rational_square_case": square,
        "out_of_budget_rational_cubic_case": cubic,
        "architectural_consequence": (
            "A falsified causal family can now search a compositional expression language by description cost and held-out exact consequence, rather than waiting for a human to name the missing feature. Grammar productions remain cheap symbolic hypotheses until receipts earn consolidation."
        ),
        "recursive_next_break": (
            "The production set {add,mul,inv} is now the brittle object. Let unresolved residuals propose new typed operators from transformations that simplify residual structure, and retain only productions that repeatedly reduce decision-relevant description length across environments."
        ),
        "claim_boundary": (
            "PASS means a bounded exact grammar search synthesized the configured reciprocal-square relations and rejected a higher-cost cubic reciprocal. It is not unrestricted symbolic regression, automatic operator invention, or proof of generalization beyond the held-out corpus."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-cost", type=int, default=6)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(args.max_cost)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
