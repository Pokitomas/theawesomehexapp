#!/usr/bin/env python3
"""Repaired court for residual_grammar_production_search.py.

The v1 negative witness used 1/(1+x^3), which has a pole at x=-1 in the
integer intervention corpus.  That is a useful failure: the court accidentally
asked the grammar to explain an undefined world rather than an out-of-budget
but lawful world.  Preserve v1 unchanged as lineage and replace only the witness
here with 1/(2+x^3), whose denominator is nonzero on every integer probe.

The architectural test is unchanged: cost<=6 should synthesize reciprocal-square
relations but must refuse the higher-description-cost cubic reciprocal.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "residual_grammar_production_search.py"


def load_base():
    spec = importlib.util.spec_from_file_location("archie_residual_grammar_v1", BASE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BASE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


B = load_base()
Q = Fraction


def rational_cubic_nonsingular(x: tuple[Q, Q]) -> tuple[Q, Q]:
    x1, x2 = x
    return (x2 + Q(1, 2 + x1 ** 3), x1 + Q(1, 2 + x2 ** 3))


def run_court(max_cost: int = 6) -> dict[str, Any]:
    square = B.compile_world("rational_square_world", B.rational_square_world, max_cost=max_cost)
    cubic = B.compile_world("rational_cubic_nonsingular_world", rational_cubic_nonsingular, max_cost=max_cost)
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
        "schema": "archie-action-latent/residual-grammar-production-search-v2",
        "pass": passed,
        "max_cost": max_cost,
        "v1_failure_preserved": "negative witness pole at integer x=-1",
        "rational_square_case": square,
        "out_of_budget_rational_cubic_case": cubic,
        "architectural_consequence": (
            "A falsified causal family can search a compositional expression language by description cost and held-out exact consequence, rather than waiting for a human to name the missing feature. Grammar productions remain hypotheses until executable receipts earn consolidation."
        ),
        "recursive_next_break": (
            "The production set {add,mul,inv} is now the brittle object. Make production vocabulary itself developmental: promote a new typed operator only when it compresses multiple independent residual families enough to repay its description cost, and demote it when adversarial holdouts erase that advantage."
        ),
        "claim_boundary": (
            "PASS means a bounded exact grammar search synthesized reciprocal-square relations and rejected a nonsingular higher-cost cubic reciprocal. It is not unrestricted symbolic regression or automatic invention of arbitrary operations."
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
