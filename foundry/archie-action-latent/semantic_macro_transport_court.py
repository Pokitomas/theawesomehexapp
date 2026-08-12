#!/usr/bin/env python3
"""Break syntactic macro identity and price abstraction by bytes + execution.

`verified_macro_induction_v2.py` can promote a repeated AST template, but it is
still fooled by surface syntax.  Equivalent programs such as

    inv(1 + x*x)
    inv((x*x + 1) * 1)
    1 * inv(x*x + 1)

should not be treated as different causal ideas merely because their trees
look different.

This court inserts an extensional-normalization layer before macro induction:

  verified program -> exact rational behavior signature -> equivalence class
  -> cheapest representative -> variable-renaming anti-unification -> macro

It then prices the abstraction in three currencies:

* serialized transport bytes for repeated trees vs one definition + calls;
* deterministic interpreter node visits;
* wall-clock Python evaluation on the CI runner (diagnostic only, never a
  promotion gate because runner timing is noisy and not Kai's local host).

A semantic collision control deliberately creates two expressions that agree on
a tiny probe set but diverge on a larger adversarial set.  Promotion therefore
requires a second independent signature court, not one finite fingerprint.

This still does not solve semantic equivalence in general; exact program
equivalence is undecidable for sufficiently rich languages.  The point is to
make syntax another falsifiable layer and to connect learned abstraction to the
memory-wall target with actual byte/dispatch accounting rather than prose.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

Q = Fraction
Point = tuple[Q, Q]


@dataclass(frozen=True)
class Expr:
    op: str
    args: tuple["Expr", ...] = ()
    atom: str = ""

    @property
    def text(self) -> str:
        if self.op == "atom":
            return self.atom
        if self.op == "inv":
            return f"inv({self.args[0].text})"
        symbol = {"add": "+", "mul": "*", "sub": "-"}[self.op]
        return f"({self.args[0].text}{symbol}{self.args[1].text})"

    @property
    def nodes(self) -> int:
        return 1 if self.op == "atom" else 1 + sum(arg.nodes for arg in self.args)

    def to_obj(self) -> Any:
        if self.op == "atom":
            return ["atom", self.atom]
        return [self.op, *[arg.to_obj() for arg in self.args]]


def atom(name: str) -> Expr:
    return Expr("atom", atom=name)


def add(a: Expr, b: Expr) -> Expr:
    return Expr("add", (a, b))


def mul(a: Expr, b: Expr) -> Expr:
    return Expr("mul", (a, b))


def sub(a: Expr, b: Expr) -> Expr:
    return Expr("sub", (a, b))


def inv(a: Expr) -> Expr:
    return Expr("inv", (a,))


ONE = atom("1")
X1 = atom("x1")
X2 = atom("x2")


def eval_expr(expr: Expr, point: Point, counter: list[int] | None = None) -> Q | None:
    if counter is not None:
        counter[0] += 1
    if expr.op == "atom":
        return {"1": Q(1), "x1": point[0], "x2": point[1]}[expr.atom]
    if expr.op == "inv":
        value = eval_expr(expr.args[0], point, counter)
        if value is None or value == 0:
            return None
        return Q(1) / value
    left = eval_expr(expr.args[0], point, counter)
    right = eval_expr(expr.args[1], point, counter)
    if left is None or right is None:
        return None
    if expr.op == "add":
        return left + right
    if expr.op == "mul":
        return left * right
    if expr.op == "sub":
        return left - right
    raise ValueError(expr.op)


def variants(variable: str) -> list[Expr]:
    x = X1 if variable == "x1" else X2
    square = mul(x, x)
    base = inv(add(ONE, square))
    return [
        base,
        inv(add(square, ONE)),
        inv(mul(add(ONE, square), ONE)),
        mul(ONE, inv(add(square, ONE))),
        inv(add(add(square, ONE), sub(x, x))),
        mul(inv(add(ONE, square)), mul(ONE, ONE)),
    ]


def train_points() -> list[Point]:
    return [
        (Q(-4), Q(-3)), (Q(-3), Q(2)), (Q(-2), Q(-1)), (Q(-1), Q(4)),
        (Q(0), Q(-2)), (Q(1), Q(3)), (Q(2), Q(-4)), (Q(3), Q(1)),
        (Q(4), Q(2)), (Q(5), Q(-1)),
    ]


def adversarial_points() -> list[Point]:
    return [
        (Q(-7), Q(5)), (Q(-5), Q(-6)), (Q(-2), Q(7)), (Q(0), Q(9)),
        (Q(2), Q(5)), (Q(6), Q(-3)), (Q(8), Q(1)), (Q(11), Q(-4)),
    ]


def signature(expr: Expr, points: list[Point]) -> tuple[Q | None, ...]:
    return tuple(eval_expr(expr, point) for point in points)


def serialized_bytes(expr: Expr) -> int:
    return len(json.dumps(expr.to_obj(), separators=(",", ":")).encode("utf-8"))


def cheapest_by_signature(expressions: Iterable[Expr], points: list[Point]) -> dict[tuple[Q | None, ...], Expr]:
    best: dict[tuple[Q | None, ...], Expr] = {}
    for expr in expressions:
        sig = signature(expr, points)
        old = best.get(sig)
        if old is None or (serialized_bytes(expr), expr.nodes, expr.text) < (
            serialized_bytes(old), old.nodes, old.text
        ):
            best[sig] = expr
    return best


def rename_variable(expr: Expr, source: str, target: str) -> Expr:
    if expr.op == "atom":
        return atom(target if expr.atom == source else expr.atom)
    return Expr(expr.op, tuple(rename_variable(arg, source, target) for arg in expr.args))


def anti_unify_variable(a: Expr, b: Expr) -> tuple[Any, bool]:
    """Return a JSON-like template where x1/x2 differences become `$v`."""
    if a.op == b.op == "atom":
        if a.atom == b.atom:
            return ["atom", a.atom], True
        if {a.atom, b.atom} <= {"x1", "x2"}:
            return ["slot", "$v"], True
        return None, False
    if a.op != b.op or len(a.args) != len(b.args):
        return None, False
    children = []
    for left, right in zip(a.args, b.args):
        child, ok = anti_unify_variable(left, right)
        if not ok:
            return None, False
        children.append(child)
    return [a.op, *children], True


def template_bytes(template: Any) -> int:
    return len(json.dumps(template, separators=(",", ":")).encode("utf-8"))


def macro_eval(variable_value: Q) -> Q:
    return Q(1) / (Q(1) + variable_value * variable_value)


def deterministic_visit_account(expressions: list[Expr], points: list[Point]) -> dict[str, int]:
    tree_visits = 0
    for expr in expressions:
        for point in points:
            counter = [0]
            value = eval_expr(expr, point, counter)
            if value is None:
                raise RuntimeError("unexpected singular source expression")
            tree_visits += counter[0]
    # Macro is modeled as five primitive visits: bind variable, mul, constant,
    # add, reciprocal. Definition cost is paid once as six AST nodes.
    macro_runtime_visits = len(expressions) * len(points) * 5
    macro_definition_visits = 6
    return {
        "tree_visits": tree_visits,
        "macro_runtime_visits": macro_runtime_visits,
        "macro_definition_visits": macro_definition_visits,
        "macro_total_visits": macro_runtime_visits + macro_definition_visits,
    }


def wallclock_diagnostic(expr: Expr, variable: str, loops: int = 30000) -> dict[str, float]:
    rng = random.Random(5602)
    values = [Q(rng.randint(-20, 20), rng.randint(1, 7)) for _ in range(256)]
    points = [(v, Q(3, 7)) if variable == "x1" else (Q(3, 7), v) for v in values]

    # Warm both paths.
    for p in points:
        eval_expr(expr, p)
        macro_eval(p[0] if variable == "x1" else p[1])

    reps = max(1, loops // len(points))
    t0 = time.perf_counter_ns()
    acc_tree = Q(0)
    for _ in range(reps):
        for p in points:
            value = eval_expr(expr, p)
            assert value is not None
            acc_tree += value
    tree_ns = time.perf_counter_ns() - t0

    t1 = time.perf_counter_ns()
    acc_macro = Q(0)
    for _ in range(reps):
        for p in points:
            v = p[0] if variable == "x1" else p[1]
            acc_macro += macro_eval(v)
    macro_ns = time.perf_counter_ns() - t1
    assert acc_tree == acc_macro
    evals = reps * len(points)
    return {
        "evaluations": evals,
        "tree_ns_per_eval": tree_ns / evals,
        "macro_ns_per_eval": macro_ns / evals,
        "tree_over_macro_ratio": tree_ns / max(1, macro_ns),
    }


def collision_control() -> dict[str, Any]:
    # On x1 in {-1,0,1}, x1^2 and x1^4 coincide. They diverge at x1=2.
    tiny = [(Q(-1), Q(0)), (Q(0), Q(0)), (Q(1), Q(0))]
    wide = [*tiny, (Q(2), Q(0)), (Q(3), Q(0))]
    square = mul(X1, X1)
    fourth = mul(square, square)
    return {
        "tiny_signature_equal": signature(square, tiny) == signature(fourth, tiny),
        "wide_signature_equal": signature(square, wide) == signature(fourth, wide),
        "tiny_square": [str(x) for x in signature(square, tiny)],
        "tiny_fourth": [str(x) for x in signature(fourth, tiny)],
        "wide_square": [str(x) for x in signature(square, wide)],
        "wide_fourth": [str(x) for x in signature(fourth, wide)],
    }


def run_court() -> dict[str, Any]:
    train = train_points()
    adversarial = adversarial_points()
    v1 = variants("x1")
    v2 = variants("x2")
    class1 = cheapest_by_signature(v1, train)
    class2 = cheapest_by_signature(v2, train)
    target_sig1 = signature(v1[0], train)
    target_sig2 = signature(v2[0], train)
    rep1 = class1[target_sig1]
    rep2 = class2[target_sig2]

    # Independent signature court catches finite-probe aliases before template
    # promotion. All intentionally equivalent variants must agree on both sets.
    train_equiv1 = all(signature(expr, train) == target_sig1 for expr in v1)
    train_equiv2 = all(signature(expr, train) == target_sig2 for expr in v2)
    adv_sig1 = signature(v1[0], adversarial)
    adv_sig2 = signature(v2[0], adversarial)
    adversarial_equiv1 = all(signature(expr, adversarial) == adv_sig1 for expr in v1)
    adversarial_equiv2 = all(signature(expr, adversarial) == adv_sig2 for expr in v2)

    template, template_ok = anti_unify_variable(rep1, rep2)
    source_occurrences = [v1[2], v2[3], v1[4], v2[5], v1[1], v2[0], v1[5], v2[2]]
    raw_transport = sum(serialized_bytes(expr) for expr in source_occurrences)
    macro_definition = template_bytes(template) if template_ok else 10**9
    # call packet = ["call","macro0","x1"] / x2
    call_x1 = len(json.dumps(["call", "macro0", "x1"], separators=(",", ":")).encode("utf-8"))
    call_x2 = len(json.dumps(["call", "macro0", "x2"], separators=(",", ":")).encode("utf-8"))
    macro_transport = macro_definition + sum(call_x1 if i % 2 == 0 else call_x2 for i in range(len(source_occurrences)))

    visits = deterministic_visit_account(source_occurrences, adversarial)
    wall = wallclock_diagnostic(rep1, "x1")
    collision = collision_control()

    # Verify macro semantics directly on an unseen coordinate set.
    heldout = [(Q(i, 3), Q(2 * i + 1, 5)) for i in range(-11, 12) if i != 0]
    heldout_x1 = all(eval_expr(rep1, p) == macro_eval(p[0]) for p in heldout)
    heldout_x2 = all(eval_expr(rep2, p) == macro_eval(p[1]) for p in heldout)

    transport_ratio = raw_transport / max(1, macro_transport)
    visit_ratio = visits["tree_visits"] / max(1, visits["macro_total_visits"])
    passed = bool(
        train_equiv1 and train_equiv2
        and adversarial_equiv1 and adversarial_equiv2
        and template_ok
        and heldout_x1 and heldout_x2
        and collision["tiny_signature_equal"]
        and not collision["wide_signature_equal"]
        and macro_transport < raw_transport
        and visits["macro_total_visits"] < visits["tree_visits"]
    )
    return {
        "schema": "archie-action-latent/semantic-macro-transport-court-v1",
        "pass": passed,
        "semantic_normalization": {
            "x1_variant_count": len(v1),
            "x2_variant_count": len(v2),
            "x1_equivalence_class_count_train": len(class1),
            "x2_equivalence_class_count_train": len(class2),
            "x1_cheapest_representative": rep1.text,
            "x2_cheapest_representative": rep2.text,
            "train_equivalent": train_equiv1 and train_equiv2,
            "independent_adversarial_equivalent": adversarial_equiv1 and adversarial_equiv2,
            "induced_template": template,
        },
        "collision_control": collision,
        "heldout_macro_exact": {"x1": heldout_x1, "x2": heldout_x2},
        "transport": {
            "occurrences": len(source_occurrences),
            "raw_tree_bytes": raw_transport,
            "macro_definition_bytes": macro_definition,
            "macro_call_bytes_x1": call_x1,
            "macro_call_bytes_x2": call_x2,
            "macro_total_bytes": macro_transport,
            "raw_over_macro_ratio": transport_ratio,
        },
        "dispatch_accounting": {**visits, "tree_over_macro_ratio": visit_ratio},
        "ci_wallclock_diagnostic_not_gate": wall,
        "architectural_consequence": (
            "Verified abstraction is now keyed by behavior before syntax. Equivalent causal programs can share one macro, reducing repeated serialized state and interpreter dispatch while an independent signature court guards against finite-probe semantic collisions."
        ),
        "memory_wall_consequence": (
            "For recurring verified motifs, carry a compact macro ID plus bound arguments through the resident event fabric rather than retransmitting or reinterpreting the full expression tree. The deterministic byte/dispatch savings here are a software analogue of compute-near-memory: move compact causes, not bulky descriptions."
        ),
        "recursive_next_break": (
            "Exact finite signatures still do not prove semantic equivalence. Promote algebraic rewrite proofs for supported operators, then move the byte/latency court onto the live local host so macro value is priced by actual cache misses, branch/dispatch cost, and GPU/CPU transfer bytes rather than CI Python timing."
        ),
        "claim_boundary": (
            "PASS establishes equivalence only on the exact train, adversarial, and held-out courts for this bounded arithmetic language. CI wall-clock is diagnostic and must not be presented as a local-hardware speedup."
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
