#!/usr/bin/env python3
"""Task-semantic causal court for Delta-rule write holonomy.

Framework-independent reference court (NumPy only).

For a Delta memory S ∈ R^{K×V}, query bank Q ∈ R^{M×K}, and downstream
linear observation W ∈ R^{V×C}, the write-order effect is

    ΔL = Q ΔS W.

If rank(Q)=K and rank(W)=V, then ΔS is reconstructible from ΔL via
Moore-Penrose inverses, so ΔS ↔ ΔL is a bijection between state-holonomy
space and the image of the observational map. A single query and a
rank-deficient W have explicit nonzero Delta-holonomy nullspace witnesses.

The court also demonstrates that context fission is task-conditional:
it removes order holonomy exactly, which helps only when order is nuisance.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np


def unit(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x)
    if n < 1e-30:
        raise ValueError("zero vector")
    return x / n


def delta_apply(S: np.ndarray, k: np.ndarray, v: np.ndarray, beta: float) -> np.ndarray:
    I = np.eye(S.shape[0], dtype=np.float64)
    return (I - beta * np.outer(k, k)) @ S + beta * np.outer(k, v)


def delta_holonomy_closed_form(S, ka, va, ba, kb, vb, bb):
    c = float(ka @ kb)
    return ba * bb * c * (
        (np.outer(kb, ka) - np.outer(ka, kb)) @ S
        + np.outer(ka, vb)
        - np.outer(kb, va)
    )


def actual_holonomy(S, ka, va, ba, kb, vb, bb):
    ab = delta_apply(delta_apply(S, ka, va, ba), kb, vb, bb)
    ba_state = delta_apply(delta_apply(S, kb, vb, bb), ka, va, ba)
    return ab - ba_state


def relerr(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-30))


def orthogonal_query_to_two_keys(ka: np.ndarray, kb: np.ndarray) -> np.ndarray:
    _, _, vh = np.linalg.svd(np.stack([ka, kb], axis=0), full_matrices=True)
    return unit(vh[-1])


def full_column_query_bank(K: int, extra: int, rng: np.random.Generator) -> np.ndarray:
    M = K + max(0, extra)
    q, _ = np.linalg.qr(rng.standard_normal((M, K)), mode="reduced")
    return q


def full_row_output_map(V: int, extra: int, rng: np.random.Generator) -> np.ndarray:
    C = V + max(0, extra)
    q, _ = np.linalg.qr(rng.standard_normal((C, V)), mode="reduced")
    return q.T.copy()


def rank_deficient_output_map(V: int, extra: int, rng: np.random.Generator):
    C = V + max(0, extra)
    z = unit(rng.standard_normal(V))
    P = np.eye(V) - np.outer(z, z)
    return P @ rng.standard_normal((V, C)), z


@dataclass
class Result:
    schema: str
    status: str
    closed_form_relative_error: float
    complete_observation_reconstruction_relative_error: float
    complete_observation_query_rank: int
    complete_observation_output_rank: int
    single_query_nonzero_holonomy_norm: float
    single_query_behavior_norm: float
    rank_deficient_nonzero_holonomy_norm: float
    rank_deficient_behavior_norm: float
    order_signal_sigma_max: float
    order_signal_scalar_effect_abs: float
    fission_shared_order_effect_norm: float
    fission_product_order_effect_norm: float
    semantic_verdict: dict[str, Any]


def run_court(K=8, V=32, seed=20260812) -> Result:
    if K < 3:
        raise ValueError("K must be >= 3")
    if V < 2:
        raise ValueError("V must be >= 2")
    rng = np.random.default_rng(seed)

    S = rng.standard_normal((K, V))
    ka = unit(rng.standard_normal(K))
    kb = unit(rng.standard_normal(K))
    c = abs(float(ka @ kb))
    while c < 0.15 or c > 0.95:
        kb = unit(rng.standard_normal(K))
        c = abs(float(ka @ kb))
    va = rng.standard_normal(V)
    vb = rng.standard_normal(V)
    ba, bb = 0.71, 0.63

    dS = actual_holonomy(S, ka, va, ba, kb, vb, bb)
    dS_formula = delta_holonomy_closed_form(S, ka, va, ba, kb, vb, bb)
    closed_err = relerr(dS_formula, dS)

    # Informationally complete observational family.
    Q = full_column_query_bank(K, 3, rng)
    W = full_row_output_map(V, 5, rng)
    dL = Q @ dS @ W
    dS_recon = np.linalg.pinv(Q) @ dL @ np.linalg.pinv(W)
    recon_err = relerr(dS_recon, dS)
    q_rank = int(np.linalg.matrix_rank(Q))
    w_rank = int(np.linalg.matrix_rank(W))

    # Explicit single-query nullspace witness within the Delta-holonomy class.
    q0 = orthogonal_query_to_two_keys(ka, kb)
    single_behavior = q0 @ dS

    # Explicit rank-deficient-output nullspace witness within pure value-conflict holonomy.
    Wbad, z = rank_deficient_output_map(V, 3, rng)
    k = unit(rng.standard_normal(K))
    va2 = rng.standard_normal(V)
    vb2 = va2 + z
    Z = np.zeros((K, V))
    b = 0.67
    dS_bad = actual_holonomy(Z, k, va2, b, k, vb2, b)
    Qgood = full_column_query_bank(K, 1, rng)
    hidden_behavior = Qgood @ dS_bad @ Wbad

    # The best scalar order detector is the top singular-vector pair.
    U, sv, Vh = np.linalg.svd(dS, full_matrices=False)
    q_star = U[:, 0]
    w_star = Vh[0, :]
    scalar_effect = abs(float(q_star @ dS @ w_star))
    sigma = float(sv[0])

    # Shared state retains order; disjoint context fibers commute.
    shared_ab = delta_apply(delta_apply(S, ka, va, ba), kb, vb, bb)
    shared_ba = delta_apply(delta_apply(S, kb, vb, bb), ka, va, ba)
    shared_effect = float(np.linalg.norm(shared_ab - shared_ba))
    fiber_a = delta_apply(S, ka, va, ba)
    fiber_b = delta_apply(S, kb, vb, bb)
    prod_ab = np.concatenate([fiber_a.ravel(), fiber_b.ravel()])
    prod_ba = np.concatenate([fiber_a.ravel(), fiber_b.ravel()])
    fission_effect = float(np.linalg.norm(prod_ab - prod_ba))

    single_h = float(np.linalg.norm(dS))
    single_b = float(np.linalg.norm(single_behavior))
    bad_h = float(np.linalg.norm(dS_bad))
    bad_b = float(np.linalg.norm(hidden_behavior))

    passed = (
        closed_err < 1e-10
        and recon_err < 1e-10
        and q_rank == K
        and w_rank == V
        and single_h > 1e-6 and single_b < 1e-10
        and bad_h > 1e-6 and bad_b < 1e-9
        and abs(scalar_effect - sigma) < 1e-10
        and shared_effect > 1e-6 and fission_effect < 1e-12
    )

    return Result(
        schema="archie-causal-holonomy-court/v1",
        status="pass" if passed else "fail",
        closed_form_relative_error=closed_err,
        complete_observation_reconstruction_relative_error=recon_err,
        complete_observation_query_rank=q_rank,
        complete_observation_output_rank=w_rank,
        single_query_nonzero_holonomy_norm=single_h,
        single_query_behavior_norm=single_b,
        rank_deficient_nonzero_holonomy_norm=bad_h,
        rank_deficient_behavior_norm=bad_b,
        order_signal_sigma_max=sigma,
        order_signal_scalar_effect_abs=scalar_effect,
        fission_shared_order_effect_norm=shared_effect,
        fission_product_order_effect_norm=fission_effect,
        semantic_verdict={
            "local_health_is_not_semantics": True,
            "random_hidden_probe_vs_adam": "not an admission comparison; task-loss gradients and explicit causal interventions are separate objects",
            "collision_divergence": "descriptive only; amplification is pathological only when the task declares the distinction invariant or harmful",
            "single_read_bijection_claim": "falsified by explicit nonzero Delta-holonomy nullspace witness",
            "causal_quotient_theorem": "If rank(Q)=K and rank(W)=V, DeltaS is exactly reconstructible from DeltaL=Q DeltaS W; the map is bijective onto its image.",
            "context_fission": {
                "order_invariant_task": "candidate improvement: removes nuisance cross-order holonomy",
                "order_sensitive_task": "candidate regression: destroys the order channel unless timing/order is represented elsewhere",
            },
            "promotion_rule": "No local tensor statistic promotes architecture. Require task-conditioned output/behavior intervention evidence plus ordinary held-out objective evidence where applicable.",
        },
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-width", type=int, default=8)
    ap.add_argument("--value-width", type=int, default=32)
    ap.add_argument("--seed", type=int, default=20260812)
    args = ap.parse_args()
    r = run_court(args.key_width, args.value_width, args.seed)
    print(json.dumps(asdict(r), indent=2, sort_keys=True, allow_nan=False))
    return 0 if r.status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
