#!/usr/bin/env python3
"""
ARCHIE Operator-Schema Court V0

Purpose:
  Falsify the assumption that every new support fingerprint must become a new
  compiled class. Demonstrate an exact family of context-indexed transition
  operators whose support classes grow linearly while the predictive operator
  family has constant rank, then show why one-step observability is insufficient:
  a planted hidden defect is invisible now but visible after composition.

Pure Python stdlib; exact arithmetic over F_p.
"""
from __future__ import annotations

import json
from typing import List, Sequence, Tuple

P = 65537
N = 10000
DIM = 4
DEGREE = 2
BAD_CONTEXT = 7331

Matrix = List[List[int]]
Row = List[int]


def eye(n: int) -> Matrix:
    return [[1 if i == j else 0 for j in range(n)] for i in range(n)]


def mat_add(a: Matrix, b: Matrix) -> Matrix:
    return [[(a[i][j] + b[i][j]) % P for j in range(len(a[0]))] for i in range(len(a))]


def mat_scale(s: int, a: Matrix) -> Matrix:
    return [[(s * a[i][j]) % P for j in range(len(a[0]))] for i in range(len(a))]


def mat_mul(a: Matrix, b: Matrix) -> Matrix:
    m, k, n = len(a), len(b), len(b[0])
    return [
        [sum(a[i][t] * b[t][j] for t in range(k)) % P for j in range(n)]
        for i in range(m)
    ]


def row_mul(r: Row, a: Matrix) -> Row:
    return [sum(r[t] * a[t][j] for t in range(len(r))) % P for j in range(len(a[0]))]


def flatten(a: Matrix) -> List[int]:
    return [x for row in a for x in row]


def inv_mod(x: int) -> int:
    if x % P == 0:
        raise ZeroDivisionError("non-invertible")
    return pow(x, P - 2, P)


def rank_mod(rows: Sequence[Sequence[int]]) -> int:
    a = [[x % P for x in row] for row in rows]
    if not a:
        return 0
    m, n = len(a), len(a[0])
    r = 0
    for c in range(n):
        pivot = next((i for i in range(r, m) if a[i][c] % P), None)
        if pivot is None:
            continue
        a[r], a[pivot] = a[pivot], a[r]
        inv = inv_mod(a[r][c])
        a[r] = [(v * inv) % P for v in a[r]]
        for i in range(m):
            if i != r and a[i][c] % P:
                f = a[i][c] % P
                a[i] = [(a[i][j] - f * a[r][j]) % P for j in range(n)]
        r += 1
        if r == m:
            break
    return r


def invert_matrix(a: Matrix) -> Matrix:
    n = len(a)
    ident = eye(n)
    aug = [[a[i][j] % P for j in range(n)] + ident[i] for i in range(n)]
    for c in range(n):
        pivot = next((i for i in range(c, n) if aug[i][c] % P), None)
        if pivot is None:
            raise ValueError("singular matrix")
        aug[c], aug[pivot] = aug[pivot], aug[c]
        inv = inv_mod(aug[c][c])
        aug[c] = [(x * inv) % P for x in aug[c]]
        for i in range(n):
            if i != c and aug[i][c] % P:
                f = aug[i][c] % P
                aug[i] = [(aug[i][j] - f * aug[c][j]) % P for j in range(2 * n)]
    return [row[n:] for row in aug]


def fit_quadratic_operator(samples: Sequence[Tuple[int, Matrix]]) -> Tuple[Matrix, Matrix, Matrix]:
    if len(samples) != 3:
        raise ValueError("quadratic fit needs exactly three contexts")
    xs = [c % P for c, _ in samples]
    vandermonde = [[1, x, (x * x) % P] for x in xs]
    vinv = invert_matrix(vandermonde)
    coeffs = [[[0 for _ in range(DIM)] for _ in range(DIM)] for _ in range(3)]
    for i in range(DIM):
        for j in range(DIM):
            ys = [samples[k][1][i][j] % P for k in range(3)]
            beta = [sum(vinv[r][k] * ys[k] for k in range(3)) % P for r in range(3)]
            for r in range(3):
                coeffs[r][i][j] = beta[r]
    return coeffs[0], coeffs[1], coeffs[2]


def eval_quadratic(coeffs: Tuple[Matrix, Matrix, Matrix], c: int) -> Matrix:
    c %= P
    return mat_add(coeffs[0], mat_add(mat_scale(c, coeffs[1]), mat_scale(c * c % P, coeffs[2])))


# Action 1 exposes coordinate 2, so a row-2 defect in action 0 is hidden from
# the immediate decoder but becomes visible after composition.
G0_0 = eye(DIM)
G0_0[0][1] = 3
G0_0[1][2] = 5
G0_1 = [[0] * DIM for _ in range(DIM)]
G0_1[1][0] = 2
G0_1[2][1] = 7
G0_2 = [[0] * DIM for _ in range(DIM)]
G0_2[3][0] = 11
G0_2[2][3] = 13

G1_0 = eye(DIM)
G1_0[0][2] = 1
G1_0[2][3] = 4
G1_1 = [[0] * DIM for _ in range(DIM)]
G1_1[0][1] = 17
G1_1[3][2] = 19
G1_2 = [[0] * DIM for _ in range(DIM)]
G1_2[1][3] = 23
G1_2[2][0] = 29

GENERATORS = {0: (G0_0, G0_1, G0_2), 1: (G1_0, G1_1, G1_2)}
C = [1, 0, 0, 0]


def clean_operator(action: int, c: int) -> Matrix:
    return eval_quadratic(GENERATORS[action], c)


def defective_operator(action: int, c: int) -> Matrix:
    m = clean_operator(action, c)
    if action == 0 and c == BAD_CONTEXT:
        m = [row[:] for row in m]
        m[2][3] = (m[2][3] + 31) % P
    return m


def one_step_signature(op: Matrix) -> Row:
    return row_mul(C, op)


def two_step_signature(op0: Matrix, op1: Matrix) -> Row:
    return row_mul(C, mat_mul(op1, op0))


def validate_family(reference_fn) -> dict:
    fitted = {
        a: fit_quadratic_operator([(c, reference_fn(a, c)) for c in (0, 1, 2)])
        for a in (0, 1)
    }
    mismatches = {0: [], 1: []}
    for c in range(N):
        for a in (0, 1):
            pred = eval_quadratic(fitted[a], c)
            ref = reference_fn(a, c)
            if pred != ref:
                mismatches[a].append(c)

    pred0 = eval_quadratic(fitted[0], BAD_CONTEXT)
    ref0 = reference_fn(0, BAD_CONTEXT)
    ref1 = reference_fn(1, BAD_CONTEXT)
    return {
        "mismatches": mismatches,
        "one_step_hidden_at_bad_context": one_step_signature(pred0) == one_step_signature(ref0),
        "two_step_future_law_exposes_bad_context": two_step_signature(pred0, ref1) != two_step_signature(ref0, ref1),
    }


def main() -> int:
    clean_fit = validate_family(clean_operator)
    defect_fit = validate_family(defective_operator)

    clean_rank_a0 = rank_mod([flatten(clean_operator(0, c)) for c in range(N)])
    clean_rank_a1 = rank_mod([flatten(clean_operator(1, c)) for c in range(N)])
    defect_rank_a0 = rank_mod([flatten(defective_operator(0, c)) for c in range(N)])

    clean_mismatch_count = sum(len(v) for v in clean_fit["mismatches"].values())
    defect_mismatch_contexts = sorted(set(defect_fit["mismatches"][0] + defect_fit["mismatches"][1]))

    class_reference_acquisitions = 2 * N
    schema_anchor_acquisitions = 2 * (DEGREE + 1)

    result = {
        "schema": "archie-operator-schema-court/v0",
        "field_prime": P,
        "contexts": N,
        "actions": 2,
        "support_classes_if_naively_keyed_by_context": N,
        "clean": {
            "action0_operator_span_rank": clean_rank_a0,
            "action1_operator_span_rank": clean_rank_a1,
            "quadratic_schema_basis_size_per_action": DEGREE + 1,
            "full_domain_matrix_mismatch_count": clean_mismatch_count,
        },
        "asymptotic_counterexample": {
            "class_reference_acquisitions": class_reference_acquisitions,
            "schema_anchor_acquisitions": schema_anchor_acquisitions,
            "schema_anchor_fraction_of_class_acquisitions": schema_anchor_acquisitions / class_reference_acquisitions,
            "statement": (
                "Distinct support fingerprints can grow linearly while a source-bound "
                "predictive operator family has constant rank. Runtime tax should track "
                "new certified law/schema dimensions, not raw support-class count."
            ),
        },
        "falsifier": {
            "bad_context": BAD_CONTEXT,
            "defective_action0_operator_span_rank": defect_rank_a0,
            "matrix_mismatch_contexts": defect_mismatch_contexts,
            "one_step_observable_probe_misses_defect": defect_fit["one_step_hidden_at_bad_context"],
            "depth2_future_law_probe_catches_defect": defect_fit["two_step_future_law_exposes_bad_context"],
        },
        "promotion_boundary": (
            "Finite samples alone do not certify an unbounded parametric law. "
            "Promotion requires a source-bound structural certificate, an exhaustive "
            "finite domain, or a conservative approximation/error-tube jurisdiction."
        ),
    }

    assert clean_rank_a0 == 3
    assert clean_rank_a1 == 3
    assert clean_mismatch_count == 0
    assert defect_rank_a0 == 4
    assert defect_mismatch_contexts == [BAD_CONTEXT]
    assert defect_fit["one_step_hidden_at_bad_context"] is True
    assert defect_fit["two_step_future_law_exposes_bad_context"] is True

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
