#!/usr/bin/env python3
"""Falsify whether soft operator mixing preserves the algebra implemented by the action bank.

The learned action bank represents each code as an affine isometry
    T_k(z) = Q_k z + b_k,  Q_k^T Q_k = I.
The current differentiable execution path forms
    T_p(z) = sum_k p_k T_k(z)
and reconstructs with
    R_p(y) = sum_k p_k Q_k^T (y - b_k).
A convex mixture of distinct orthogonal maps is generally not orthogonal, and
R_p is generally not T_p^{-1}. This court exercises the exact tensor operations
used by operator_predictive_core.py and compares soft mixing with hard code
execution. PASS means the court successfully exposes the semantic defect; it
is not a promotion of the hard selector as the final architecture.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import torch

HERE = Path(__file__).resolve().parent
CORE_PATH = HERE / "operator_predictive_core.py"


def load_core():
    spec = importlib.util.spec_from_file_location("archie_operator_core_for_mixture_court", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CORE = load_core()


def configure_two_distinct_isometries(device: torch.device) -> Any:
    bank = CORE.CayleyActionBank(codes=2, dim=2).to(device)
    # Code 0: identity. Code 1: Cayley transform of [[0,-1],[1,0]],
    # which is a 90-degree rotation. Zero translations isolate the linear law.
    with torch.no_grad():
        bank.raw.zero_()
        bank.raw[1].copy_(torch.tensor([[0.0, -1.0], [1.0, 0.0]], device=device))
        bank.translation.zero_()
    return bank


def soft_execute(bank: Any, z: torch.Tensor, probs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    candidates = bank.forward_all(z)
    y = torch.einsum("bk,bkd->bd", probs, candidates)
    inverse_candidates = bank.inverse_all(y)
    recovered = torch.einsum("bk,bkd->bd", probs, inverse_candidates)
    return y, recovered


def hard_execute(bank: Any, z: torch.Tensor, probs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    index = probs.argmax(dim=-1)
    q = bank.matrices()[index]
    b = bank.translation[index]
    y = torch.einsum("bij,bj->bi", q, z) + b
    recovered = torch.einsum("bji,bj->bi", q, y - b)
    return y, recovered


def max_abs(x: torch.Tensor) -> float:
    return float(x.abs().max().detach().cpu().item())


def run_court(device: str = "cpu") -> dict[str, Any]:
    dev = torch.device(device)
    bank = configure_two_distinct_isometries(dev)
    q = bank.matrices()
    eye = torch.eye(2, device=dev)
    per_code_orthogonality = max_abs(q.transpose(-1, -2) @ q - eye.expand(2, -1, -1))

    z = torch.tensor(
        [[1.0, 0.5], [-0.75, 1.25], [2.0, -1.0], [-1.5, -0.25]],
        device=dev,
    )
    sweep: list[dict[str, float]] = []
    for p1 in (0.0, 0.25, 0.5, 0.75, 1.0):
        probs = torch.tensor([[1.0 - p1, p1]], device=dev).expand(z.shape[0], -1)
        soft_y, soft_recovered = soft_execute(bank, z, probs)
        hard_y, hard_recovered = hard_execute(bank, z, probs)
        mix = (1.0 - p1) * q[0] + p1 * q[1]
        mix_isometry_defect = max_abs(mix.T @ mix - eye)
        sweep.append({
            "p_code_1": p1,
            "soft_roundtrip_max_abs_error": max_abs(soft_recovered - z),
            "soft_linear_isometry_defect": mix_isometry_defect,
            "hard_roundtrip_max_abs_error": max_abs(hard_recovered - z),
            "soft_vs_hard_output_max_abs_delta": max_abs(soft_y - hard_y),
        })

    mixed = [row for row in sweep if 0.0 < row["p_code_1"] < 1.0]
    endpoints = [row for row in sweep if row["p_code_1"] in (0.0, 1.0)]
    min_mixed_roundtrip = min(row["soft_roundtrip_max_abs_error"] for row in mixed)
    min_mixed_isometry_defect = min(row["soft_linear_isometry_defect"] for row in mixed)
    max_hard_roundtrip = max(row["hard_roundtrip_max_abs_error"] for row in sweep)
    max_endpoint_soft_roundtrip = max(row["soft_roundtrip_max_abs_error"] for row in endpoints)

    passed = bool(
        per_code_orthogonality < 1e-5
        and max_endpoint_soft_roundtrip < 1e-5
        and min_mixed_roundtrip > 1e-3
        and min_mixed_isometry_defect > 1e-3
        and max_hard_roundtrip < 1e-5
    )
    return {
        "schema": "archie-action-latent/operator-mixture-semantics-court-v1",
        "pass": passed,
        "tensor_shapes": {
            "Q": list(q.shape),
            "z": list(z.shape),
            "candidate_forward": [z.shape[0], 2, 2],
            "probabilities": [z.shape[0], 2],
        },
        "per_code_orthogonality_max_abs_error": per_code_orthogonality,
        "min_mixed_soft_roundtrip_max_abs_error": min_mixed_roundtrip,
        "min_mixed_soft_linear_isometry_defect": min_mixed_isometry_defect,
        "max_hard_roundtrip_max_abs_error": max_hard_roundtrip,
        "max_endpoint_soft_roundtrip_max_abs_error": max_endpoint_soft_roundtrip,
        "sweep": sweep,
        "falsified_claim": (
            "Per-code affine-isometry semantics do not automatically survive the current soft probability mixture. "
            "The soft reconstruction is not generally the inverse of the soft forward map."
        ),
        "claim_boundary": (
            "PASS only establishes a code/math mismatch for soft mixtures of distinct operators in this exact two-code tensor court. "
            "It does not prove that argmax, straight-through estimators, Gumbel routing, or any other discrete mechanism is the right replacement."
        ),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--device", default="cpu")
    p.add_argument("--output")
    args = p.parse_args()
    result = run_court(args.device)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
