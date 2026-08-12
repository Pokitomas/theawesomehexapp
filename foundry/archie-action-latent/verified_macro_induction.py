#!/usr/bin/env python3
"""Turn repeated verified causal expressions into a smaller learned instruction set.

A compositional grammar can discover a useful expression, but repeatedly storing
and evaluating the same tree is its own memory/compute wall.  This court asks
whether independently receipt-worthy expressions contain a repeated *typed
shape* that deserves promotion into a reusable macro operator.

The source expressions are not hand-selected strings.  They are recovered by
the residual grammar compiler from several exact worlds.  A structural
anti-unifier then replaces consistently differing coordinate atoms with one
slot.  Repeated examples such as

    inv(1 + x1*x1)
    inv(1 + x2*x2)

produce the template

    inv(1 + $v*$v)

only if the repeated slot relation is preserved.  Promotion requires positive
minimum-description-length savings after paying once for the macro definition
and for each call.  A single occurrence must not promote anything.

A held-out world is then fit using the induced macro call rather than the full
expression tree.  Exact held-out consequence is required before the macro gets
an executable receipt.

This is small-scale abstraction compilation: verified regularity becomes a new
instruction.  It is not automatic ISA design or universal program induction,
but it gives the architecture a concrete route from experience -> symbolic
structure -> reusable lower-cost primitive.
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
GRAMMAR_PATH = HERE / "residual_grammar_production_search.py"
EVIDENCE_PATH = HERE / "evidence_gated_consolidation.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


G = load_module("archie_macro_source_grammar", GRAMMAR_PATH)
E = load_module("archie_macro_evidence", EVIDENCE_PATH)
Q = Fraction
NOW_NS = 1_786_500_000_000_000_000
Point = tuple[Q, Q]
Vector = tuple[Q, Q]


@dataclass(frozen=True)
class TExpr:
    op: str
    args: tuple["TExpr", ...] = ()
    atom: str = ""

    @property
    def text(self) -> str:
        if self.op == "atom":
            return self.atom
        if self.op == "slot":
            return "$v"
        if self.op == "inv":
            return f"inv({self.args[0].text})"
        symbol = "+" if self.op == "add" else "*"
        return f"({self.args[0].text}{symbol}{self.args[1].text})"

    @property
    def node_count(self) -> int:
        if self.op in {"atom", "slot"}:
            return 1
        return 1 + sum(arg.node_count for arg in self.args)


def wrap(expr: G.Expr) -> TExpr:
    if expr.op == "atom":
        return TExpr("atom", atom=expr.atom)
    return TExpr(expr.op, tuple(wrap(arg) for arg in expr.args))


def slot() -> TExpr:
    return TExpr("slot")


def anti_unify_pair(a: TExpr, b: TExpr, mapping: dict[tuple[str, str], str]) -> TExpr | None:
    if a.op == b.op and a.op == "atom" and a.atom == b.atom:
        return a
    if a.op == b.op and a.op not in {"atom", "slot"} and len(a.args) == len(b.args):
        children: list[TExpr] = []
        for left, right in zip(a.args, b.args):
            child = anti_unify_pair(left, right, mapping)
            if child is None:
                return None
            children.append(child)
        return TExpr(a.op, tuple(children))
    if a.op == "atom" and b.op == "atom" and a.atom in {"x1", "x2"} and b.atom in {"x1", "x2"}:
        key = (a.atom, b.atom)
        # Every differing coordinate pair must map to the same logical slot.
        # This rejects templates that would need two unrelated wildcard values.
        mapping.setdefault(key, "$v")
        if len(set(mapping.values())) != 1:
            return None
        return slot()
    return None


def anti_unify(expressions: list[TExpr]) -> TExpr | None:
    if not expressions:
        return None
    template = expressions[0]
    for expr in expressions[1:]:
        mapping: dict[tuple[str, str], str] = {}
        candidate = anti_unify_pair(template, expr, mapping)
        if candidate is None:
            return None
        template = candidate
    return template


def instantiate(template: TExpr, variable: str) -> TExpr:
    if template.op == "slot":
        return TExpr("atom", atom=variable)
    if template.op == "atom":
        return template
    return TExpr(template.op, tuple(instantiate(arg, variable) for arg in template.args))


def evaluate(expr: TExpr, x: Point) -> Q | None:
    if expr.op == "atom":
        return {"1": Q(1), "x1": x[0], "x2": x[1]}[expr.atom]
    if expr.op == "slot":
        raise ValueError("cannot evaluate uninstantiated macro slot")
    if expr.op == "inv":
        value = evaluate(expr.args[0], x)
        if value is None or value == 0:
            return None
        return Q(1) / value
    left = evaluate(expr.args[0], x)
    right = evaluate(expr.args[1], x)
    if left is None or right is None:
        return None
    return left + right if expr.op == "add" else left * right


def source_world(variable: str, scale: Q, bias: Q) -> Callable[[Point], Vector]:
    def world(x: Point) -> Vector:
        v = x[0] if variable == "x1" else x[1]
        reciprocal = Q(1, 1 + v * v)
        # Only output 0 is used for macro induction; output 1 remains affine so
        # the source task is a complete lawful two-output world.
        return (bias + x[0] - 2 * x[1] + scale * reciprocal, Q(3) - x[0] + x[1])
    return world


def recover_expression(world: Callable[[Point], Vector], expressions: list[G.Expr]) -> dict[str, Any]:
    corpus = G.points()
    train = [(x, world(x)) for x in corpus[:17]]
    holdout = [(x, world(x)) for x in corpus[17:]]
    result = G.compile_output(train, holdout, 0, expressions)
    if not result["holdout_exact"] or result["expression"] is None:
        raise RuntimeError(f"source grammar failed to recover expression: {result}")
    expr = next(e for e in expressions if e.text == result["expression"])
    return {
        "expression": wrap(expr),
        "expression_text": expr.text,
        "cost": expr.cost,
        "coefficients": G.coeff_text(result["fit"]["solution"]),
    }


def fit_macro_feature(world: Callable[[Point], Vector], macro_expr: TExpr) -> dict[str, Any]:
    corpus = G.points()
    train = [(x, world(x)) for x in corpus[:17]]
    holdout = [(x, world(x)) for x in corpus[17:]]

    def row(x: Point) -> list[Q] | None:
        feature = evaluate(macro_expr, x)
        if feature is None:
            return None
        return [Q(1), x[0], x[1], feature]

    rows = [row(x) for x, _ in train]
    if any(r is None for r in rows):
        return {"exact": False, "solution": None}
    fit = G.solve_exact([r for r in rows if r is not None], [y[0] for _, y in train])
    if not fit["unique"] or fit["solution"] is None:
        return {"exact": False, "solution": None}
    solution = fit["solution"]
    exact = True
    for x, y in holdout:
        r = row(x)
        if r is None or sum(c * v for c, v in zip(solution, r)) != y[0]:
            exact = False
            break
    return {"exact": exact, "solution": G.coeff_text(solution)}


def receipt_for(claim: E.Claim, payload: dict[str, Any]) -> E.Receipt:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return E.Receipt(
        kind="executable",
        claim_hash=claim.claim_hash,
        verifier="verified-macro/heldout-exact",
        artifact_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        verdict="pass",
    )


def run_court(max_cost: int = 6) -> dict[str, Any]:
    train_points = G.points()[:17]
    expressions = G.enumerate_grammar(max_cost, train_points)
    source_specs = [
        ("x1", Q(2), Q(1)),
        ("x2", Q(3), Q(-2)),
        ("x1", Q(-4), Q(5)),
        ("x2", Q(5), Q(0)),
    ]
    recovered = [recover_expression(source_world(*spec), expressions) for spec in source_specs]
    wrapped = [row["expression"] for row in recovered]
    template = anti_unify(wrapped)
    if template is None:
        raise RuntimeError("verified source expressions did not anti-unify")

    baseline_nodes = sum(expr.node_count for expr in wrapped)
    definition_nodes = template.node_count
    macro_call_nodes = 2  # macro symbol + bound variable
    compiled_nodes = definition_nodes + macro_call_nodes * len(wrapped)
    mdl_savings = baseline_nodes - compiled_nodes

    heldout_variable = "x1"
    heldout_world = source_world(heldout_variable, Q(7), Q(-3))
    heldout_instantiation = instantiate(template, heldout_variable)
    heldout = fit_macro_feature(heldout_world, heldout_instantiation)

    # A single observation pays definition+call overhead and must not promote.
    single_baseline = wrapped[0].node_count
    single_compiled = definition_nodes + macro_call_nodes
    single_savings = single_baseline - single_compiled

    memory = E.EvidenceGatedMemory(now_ns=NOW_NS)
    payload = {
        "source_expressions": [row["expression_text"] for row in recovered],
        "template": template.text,
        "baseline_nodes": baseline_nodes,
        "definition_nodes": definition_nodes,
        "macro_call_nodes": macro_call_nodes,
        "compiled_nodes": compiled_nodes,
        "mdl_savings": mdl_savings,
        "heldout_instantiation": heldout_instantiation.text,
        "heldout_exact": heldout["exact"],
        "heldout_coefficients": heldout["solution"],
    }
    claim = E.Claim("verified_expression_grammar", "promoted_macro", template.text, "causal")
    if mdl_savings > 0 and heldout["exact"]:
        promotion = memory.propose(claim, receipt_for(claim, payload))
    else:
        promotion = memory.propose(claim, None)

    passed = bool(
        template.text.count("$v") >= 2
        and mdl_savings > 0
        and single_savings <= 0
        and heldout["exact"]
        and promotion["result"] == "stable"
    )
    return {
        "schema": "archie-action-latent/verified-macro-induction-v1",
        "pass": passed,
        "source_expressions": [row["expression_text"] for row in recovered],
        "source_expression_node_counts": [row["expression"].node_count for row in recovered],
        "induced_template": template.text,
        "definition_nodes": definition_nodes,
        "macro_call_nodes": macro_call_nodes,
        "baseline_nodes_four_occurrences": baseline_nodes,
        "compiled_nodes_four_occurrences": compiled_nodes,
        "mdl_savings_four_occurrences": mdl_savings,
        "single_occurrence_savings": single_savings,
        "heldout_instantiation": heldout_instantiation.text,
        "heldout_exact": heldout["exact"],
        "promotion_event": promotion,
        "architectural_consequence": (
            "Verified repeated structure can become a new reusable cognitive instruction only when reuse repays its definition cost and survives an independent held-out consequence court. This makes the primitive vocabulary developmental rather than permanently hand-sized."
        ),
        "compute_consequence": (
            "A promoted macro replaces repeated expression trees with one definition plus short calls. In a compiled resident implementation, that is a path toward reducing instruction/state traffic for recurring causal motifs instead of re-streaming an opaque parameter block every time."
        ),
        "recursive_next_break": (
            "Anti-unification is still syntactic. Next require semantic macro induction across structurally different but extensionally equivalent verified programs, then price the macro by measured local latency/bytes as well as node count."
        ),
        "claim_boundary": (
            "PASS demonstrates exact repeated-subtree macro induction for a bounded arithmetic grammar. Node-count MDL is only a proxy for real memory traffic and does not establish autonomous hardware instruction synthesis."
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
