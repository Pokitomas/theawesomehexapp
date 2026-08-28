#!/usr/bin/env python3
"""
ARCHIE Delta Observable-Component Court V0

Exact Fraction arithmetic for the Delta recurrence

    S <- (I - beta k k^T) S + beta k v^T

The court demonstrates:
1) the smallest future-query-visible row subspace can be obtained by closure
   from query vectors through nonzero key Gram overlaps;
2) key/write events in disconnected components can be skipped exactly for the
   declared query family;
3) a single bridge key invalidates the old component certificate and can make
   previously hidden state visible;
4) recomputing closure restores exactness.

Pure Python stdlib.
"""
from __future__ import annotations

import json
from fractions import Fraction
from typing import List, Sequence, Tuple

D = 12
DV = 2
BETA = Fraction(1, 4)

Vector = Tuple[Fraction, ...]
State = List[List[Fraction]]


def vec(*pairs: Tuple[int, int]) -> Vector:
    out = [Fraction(0) for _ in range(D)]
    for idx, value in pairs:
        out[idx] = Fraction(value)
    return tuple(out)


def dot(a: Vector, b: Vector) -> Fraction:
    return sum((x * y for x, y in zip(a, b)), Fraction(0))


def rank(vectors: Sequence[Vector]) -> int:
    if not vectors:
        return 0
    a = [list(v) for v in vectors]
    m, n = len(a), len(a[0])
    r = 0
    for c in range(n):
        pivot = next((i for i in range(r, m) if a[i][c] != 0), None)
        if pivot is None:
            continue
        a[r], a[pivot] = a[pivot], a[r]
        p = a[r][c]
        a[r] = [x / p for x in a[r]]
        for i in range(m):
            if i != r and a[i][c] != 0:
                f = a[i][c]
                a[i] = [a[i][j] - f * a[r][j] for j in range(n)]
        r += 1
        if r == m:
            break
    return r


def independent_append(basis: List[Vector], v: Vector) -> bool:
    if rank(basis + [v]) > rank(basis):
        basis.append(v)
        return True
    return False


def observable_closure(queries: Sequence[Vector], keys: Sequence[Vector]) -> List[Vector]:
    basis: List[Vector] = []
    for q in queries:
        independent_append(basis, q)
    changed = True
    while changed:
        changed = False
        for k in keys:
            if any(dot(k, u) != 0 for u in basis):
                if independent_append(basis, k):
                    changed = True
    return basis


def in_span(v: Vector, basis: Sequence[Vector]) -> bool:
    return rank(list(basis) + [v]) == rank(basis)


def zero_state() -> State:
    return [[Fraction(0) for _ in range(DV)] for _ in range(D)]


def delta_step(S: State, k: Vector, value: Tuple[Fraction, Fraction], beta: Fraction = BETA) -> State:
    read = [
        sum((k[i] * S[i][j] for i in range(D)), Fraction(0))
        for j in range(DV)
    ]
    err = [value[j] - read[j] for j in range(DV)]
    out = [row[:] for row in S]
    for i in range(D):
        if k[i] == 0:
            continue
        for j in range(DV):
            out[i][j] += beta * k[i] * err[j]
    return out


def query_read(q: Vector, S: State) -> Tuple[Fraction, Fraction]:
    return tuple(
        sum((q[i] * S[i][j] for i in range(D)), Fraction(0))
        for j in range(DV)
    )


def run(events, q: Vector, closure_basis: Sequence[Vector] | None) -> List[Tuple[Fraction, Fraction]]:
    S = zero_state()
    reads = []
    for k, value in events:
        if closure_basis is None or in_span(k, closure_basis):
            S = delta_step(S, k, value)
        reads.append(query_read(q, S))
    return reads


def max_abs_diff(a, b) -> Fraction:
    worst = Fraction(0)
    for xa, xb in zip(a, b):
        for u, v in zip(xa, xb):
            worst = max(worst, abs(u - v))
    return worst


q = vec((0, 1))
A1 = vec((0, 1), (1, 1))
A2 = vec((1, 1), (2, 1))

B0 = vec((3, 1))
B1 = vec((3, 1), (4, 1))
B2 = vec((4, 1), (5, 1))
B3 = vec((5, 1), (6, 1))
B4 = vec((6, 1), (7, 1))

C0 = vec((8, 1))
C1 = vec((8, 1), (9, 1))
C2 = vec((9, 1), (10, 1))
C3 = vec((10, 1), (11, 1))

BRIDGE = vec((0, 1), (3, 1))

CLEAN_KEYS = [A1, A2, B0, B1, B2, B3, B4, C0, C1, C2, C3]
BRIDGED_KEYS = CLEAN_KEYS + [BRIDGE]


def build_clean_events(n: int = 1200):
    events = []
    for t in range(n):
        k = CLEAN_KEYS[(7 * t + 3) % len(CLEAN_KEYS)]
        value = (Fraction((11 * t + 5) % 17 - 8), Fraction((13 * t + 2) % 19 - 9))
        events.append((k, value))
    return events


def main() -> int:
    clean_basis = observable_closure([q], CLEAN_KEYS)
    bridged_basis = observable_closure([q], BRIDGED_KEYS)

    clean_events = build_clean_events()
    full_clean = run(clean_events, q, None)
    reduced_clean = run(clean_events, q, clean_basis)
    clean_error = max_abs_diff(full_clean, reduced_clean)

    clean_relevant = sum(1 for k, _ in clean_events if in_span(k, clean_basis))
    clean_skipped = len(clean_events) - clean_relevant

    mutation_events = [
        (B0, (Fraction(8), Fraction(-3))),
        (B1, (Fraction(5), Fraction(2))),
        (BRIDGE, (Fraction(0), Fraction(0))),
        (A1, (Fraction(1), Fraction(1))),
    ]
    full_mutation = run(mutation_events, q, None)
    stale_reduced = run(mutation_events, q, clean_basis)
    recertified_reduced = run(mutation_events, q, bridged_basis)

    stale_error = max_abs_diff(full_mutation, stale_reduced)
    recertified_error = max_abs_diff(full_mutation, recertified_reduced)

    result = {
        "schema": "archie-delta-observable-component-court/v0",
        "state_row_dimension": D,
        "value_dimension": DV,
        "clean": {
            "observable_closure_rank": rank(clean_basis),
            "hidden_dimensions_exactly_excluded": D - rank(clean_basis),
            "events": len(clean_events),
            "events_exactly_skipped": clean_skipped,
            "skipped_fraction": clean_skipped / len(clean_events),
            "max_read_abs_error": float(clean_error),
            "exact_read_match": clean_error == 0,
        },
        "bridge_falsifier": {
            "bridge_key": "e0 + e3",
            "closure_rank_before": rank(clean_basis),
            "closure_rank_after": rank(bridged_basis),
            "stale_certificate_max_read_abs_error": float(stale_error),
            "stale_certificate_fails": stale_error != 0,
            "recertified_max_read_abs_error": float(recertified_error),
            "recertified_exact_match": recertified_error == 0,
        },
        "mechanism": (
            "For nonzero beta, the smallest row subspace containing the declared "
            "queries and invariant under E(k)=I-beta*k*k^T is obtained by repeatedly "
            "adding any key with nonzero Gram overlap with the current subspace. "
            "Keys outside the fixed point are orthogonal to every backward-propagated "
            "supported query, so their writes/erasures are exactly invisible until a "
            "support mutation introduces a bridge."
        ),
        "live_translation": (
            "Measure query/key Gram connectivity on real Delta traces. Candidate "
            "block/component skipping is exact only for zero cross-component coupling; "
            "near-zero finite-precision edges require multiscale bridge attacks and "
            "error-tube jurisdiction before any runtime skip."
        ),
    }

    assert rank(clean_basis) == 3
    assert rank(bridged_basis) == 8
    assert clean_error == 0
    assert clean_skipped > len(clean_events) // 2
    assert stale_error != 0
    assert recertified_error == 0

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
