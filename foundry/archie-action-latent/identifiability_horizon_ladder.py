#!/usr/bin/env python3
"""No fixed passive trajectory horizon universally identifies an action operator.

The second-order court defeats one-transition action identity.  A tempting
reaction is to decree that two transitions are enough.  This file recursively
breaks that decree.

For every requested horizon k, it constructs two *distinct bijections* U_k and
V_k on a finite state space whose orbit from state 0 is identical for exactly k
transitions and diverges on transition k+1.  Thus every deterministic encoder of
that entire k-step observed trajectory receives exactly the same input under two
causal operators with different futures.

Construction on states 0..k+2:

  both: 0->1->...->k
  U_k:  k->k+1, k+1->k+2, k+2->0
  V_k:  k->k+2, k+1->0,   k+2->k+1

Both maps are permutations, so the witness does not rely on irreversible
information loss.  Increasing a fixed context horizon only moves the
counterexample.  The architectural escape is active identification plus an
explicit hypothesis set: stay uncertain until an intervention or naturally
arriving transition distinguishes the candidate operators.

This is a worst-case theorem-by-construction for finite black-box dynamics, not
a statement that real environments are adversarial at every horizon.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def make_pair(k: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    if k < 1:
        raise ValueError("k must be >= 1")
    n = k + 3
    u = [-1] * n
    v = [-1] * n
    for s in range(k):
        u[s] = s + 1
        v[s] = s + 1
    u[k] = k + 1
    u[k + 1] = k + 2
    u[k + 2] = 0

    v[k] = k + 2
    v[k + 1] = 0
    v[k + 2] = k + 1
    return tuple(u), tuple(v)


def is_permutation(op: tuple[int, ...]) -> bool:
    return sorted(op) == list(range(len(op)))


def orbit(op: tuple[int, ...], start: int, transitions: int) -> tuple[int, ...]:
    states = [start]
    state = start
    for _ in range(transitions):
        state = op[state]
        states.append(state)
    return tuple(states)


def witness(k: int) -> dict[str, Any]:
    u, v = make_pair(k)
    prefix_u = orbit(u, 0, k)
    prefix_v = orbit(v, 0, k)
    next_u = orbit(u, 0, k + 1)[-1]
    next_v = orbit(v, 0, k + 1)[-1]
    payload = json.dumps({"k": k, "u": u, "v": v}, separators=(",", ":"), sort_keys=True)
    return {
        "horizon": k,
        "state_count": k + 3,
        "u_is_bijection": is_permutation(u),
        "v_is_bijection": is_permutation(v),
        "operators_distinct": u != v,
        "observed_prefix": list(prefix_u),
        "prefix_identical": prefix_u == prefix_v,
        "next_state_u": next_u,
        "next_state_v": next_v,
        "future_diverges": next_u != next_v,
        "deterministic_operator_identity_bayes_ceiling_balanced": 0.5 if prefix_u == prefix_v and next_u != next_v else 1.0,
        "witness_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    }


def run_court(max_horizon: int) -> dict[str, Any]:
    rows = [witness(k) for k in range(1, max_horizon + 1)]
    passed = bool(
        rows
        and all(r["u_is_bijection"] and r["v_is_bijection"] for r in rows)
        and all(r["operators_distinct"] for r in rows)
        and all(r["prefix_identical"] and r["future_diverges"] for r in rows)
        and all(r["deterministic_operator_identity_bayes_ceiling_balanced"] == 0.5 for r in rows)
    )
    return {
        "schema": "archie-action-latent/identifiability-horizon-ladder-v1",
        "pass": passed,
        "max_horizon": max_horizon,
        "witnesses": rows,
        "architectural_consequence": (
            "Do not freeze a universal observation order into the architecture. Passive history length is an evidence budget, not a guarantee. "
            "Maintain a distribution/set of still-compatible operators and choose interventions for expected discrimination when ambiguity matters. Compress or consolidate only after observational equivalence is broken."
        ),
        "frontier_consequence": (
            "This turns context from 'store ever more tokens' into 'retain the distinctions that remain decision-relevant.' Exact exterior episodes preserve unresolved evidence; the resident state may stay compact by carrying a causal equivalence class plus active uncertainty."
        ),
        "claim_boundary": (
            "PASS constructs finite reversible black-box counterexamples through the tested horizon and the same formula extends to arbitrary finite k. It does not imply real tasks require unbounded experiments or that active identification is computationally cheap."
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
