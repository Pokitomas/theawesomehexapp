#!/usr/bin/env python3
"""Repair verified macro induction without erasing the failed v1 lineage.

V1 could anti-unify the first pair of coordinate-specific expressions, but its
newly created `$v` slot was not itself accepted when folding in a third example.
That is a real recursion bug in the abstraction mechanism.  This wrapper keeps
v1 untouched, extends anti-unification with slot-vs-coordinate compatibility,
and reruns the exact same court.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "verified_macro_induction.py"


def load_base():
    spec = importlib.util.spec_from_file_location("archie_verified_macro_v1", BASE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BASE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


B = load_base()


def anti_unify_pair(a, b, mapping):
    if a.op == "slot" and b.op in {"slot", "atom"}:
        if b.op == "slot" or b.atom in {"x1", "x2"}:
            return B.slot()
    if b.op == "slot" and a.op in {"slot", "atom"}:
        if a.op == "slot" or a.atom in {"x1", "x2"}:
            return B.slot()
    if a.op == b.op and a.op == "atom" and a.atom == b.atom:
        return a
    if a.op == b.op and a.op not in {"atom", "slot"} and len(a.args) == len(b.args):
        children = []
        for left, right in zip(a.args, b.args):
            child = anti_unify_pair(left, right, mapping)
            if child is None:
                return None
            children.append(child)
        return B.TExpr(a.op, tuple(children))
    if a.op == "atom" and b.op == "atom" and a.atom in {"x1", "x2"} and b.atom in {"x1", "x2"}:
        mapping.setdefault((a.atom, b.atom), "$v")
        return B.slot()
    return None


def anti_unify(expressions):
    if not expressions:
        return None
    template = expressions[0]
    for expr in expressions[1:]:
        template = anti_unify_pair(template, expr, {})
        if template is None:
            return None
    return template


B.anti_unify_pair = anti_unify_pair
B.anti_unify = anti_unify


def run_court(max_cost: int = 6):
    result = B.run_court(max_cost)
    result["schema"] = "archie-action-latent/verified-macro-induction-v2"
    result["v1_failure_preserved"] = "folding an induced slot into a third example returned None"
    return result


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
