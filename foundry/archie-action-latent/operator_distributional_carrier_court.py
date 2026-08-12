#!/usr/bin/env python3
"""Test a distributional interpretation of soft latent operators without collapsing the code axis.

A soft code vector p does not have to denote the averaged map sum_k p_k T_k.
It can instead denote a finite probability measure over lawful arrows T_k. In
PyTorch that means the semantic object remains [batch, code, state] together
with [batch, code] weights until a downstream observation actually requires a
quotient/expectation. Branchwise inversion can then remain exact even when the
mean state is not invertible.

PASS establishes only the algebra/tensor distinction in a two-code court. It
is not a claim that a distributional carrier is the final ARCHIE state type.
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
    spec = importlib.util.spec_from_file_location("archie_operator_core_for_distributional_court", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CORE = load_core()


def configure_bank(device: torch.device) -> Any:
    bank = CORE.CayleyActionBank(codes=2, dim=2).to(device)
    with torch.no_grad():
        bank.raw.zero_()
        bank.raw[1].copy_(torch.tensor([[0.0, -1.0], [1.0, 0.0]], device=device))
        bank.translation.zero_()
    return bank


def max_abs(x: torch.Tensor) -> float:
    return float(x.abs().max().detach().cpu().item())


def weighted_variance(support: torch.Tensor, probs: torch.Tensor, mean: torch.Tensor) -> torch.Tensor:
    delta = support - mean[:, None, :]
    return torch.einsum("bk,bkd->bd", probs, delta * delta)


def run_court(device: str = "cpu") -> dict[str, Any]:
    dev = torch.device(device)
    bank = configure_bank(dev)
    q = bank.matrices()
    z = torch.tensor([[1.0, 0.5], [-0.75, 1.25], [2.0, -1.0]], device=dev)
    probs = torch.tensor([[0.5, 0.5], [0.25, 0.75], [0.7, 0.3]], device=dev)

    # Distributional carrier: keep K as a semantic axis.
    support = bank.forward_all(z)  # [B,K,D]
    centered = support - bank.translation[None, :, :]
    recovered_support = torch.einsum("kji,bkj->bki", q, centered)
    target_support = z[:, None, :].expand_as(recovered_support)
    branchwise_roundtrip = max_abs(recovered_support - target_support)

    # Current expected-state collapse: eliminate K before the ambiguity is resolved.
    mean = torch.einsum("bk,bkd->bd", probs, support)
    inverse_candidates = bank.inverse_all(mean)
    recovered_mean = torch.einsum("bk,bkd->bd", probs, inverse_candidates)
    mean_roundtrip = max_abs(recovered_mean - z)

    variance = weighted_variance(support, probs, mean)
    min_total_variance = float(variance.sum(-1).min().detach().cpu().item())

    # A second soft action composes by a product measure over arrow pairs. The
    # tensor grows a second code axis rather than pretending the expectation is
    # itself an isometry. Every branch remains an exact composition Q_j Q_k.
    probs2 = torch.tensor([[0.6, 0.4], [0.5, 0.5], [0.2, 0.8]], device=dev)
    support2 = torch.einsum("lij,bkj->bkli", q, support)
    pair_weights = probs[:, :, None] * probs2[:, None, :]
    pair_weight_error = max_abs(pair_weights.sum(dim=(1, 2)) - torch.ones(z.shape[0], device=dev))
    composed_q = torch.einsum("lij,kjm->klim", q, q)
    recovered2 = torch.einsum("klji,bklj->bkli", composed_q, support2)
    target2 = z[:, None, None, :].expand_as(recovered2)
    composition_roundtrip = max_abs(recovered2 - target2)

    passed = bool(
        branchwise_roundtrip < 1e-5
        and composition_roundtrip < 1e-5
        and pair_weight_error < 1e-6
        and min_total_variance > 1e-3
        and mean_roundtrip > 1e-3
    )
    return {
        "schema": "archie-action-latent/operator-distributional-carrier-court-v1",
        "pass": passed,
        "tensor_shapes": {
            "state": list(z.shape),
            "probabilities": list(probs.shape),
            "one_step_support": list(support.shape),
            "two_step_support": list(support2.shape),
            "pair_weights": list(pair_weights.shape),
        },
        "branchwise_roundtrip_max_abs_error": branchwise_roundtrip,
        "two_step_composition_roundtrip_max_abs_error": composition_roundtrip,
        "pair_weight_sum_max_abs_error": pair_weight_error,
        "expected_state_roundtrip_max_abs_error": mean_roundtrip,
        "min_support_total_variance": min_total_variance,
        "candidate_semantics": (
            "Treat soft latent codes as a finite measure over lawful operator arrows and delay contraction of the code axis. "
            "Composition is then product-measure support expansion (or a later justified compression), not convex averaging inside the group."
        ),
        "claim_boundary": (
            "PASS proves only that this tensor typing preserves branchwise inverse/composition information that expectation collapse destroys "
            "in the exact two-code court. It does not establish tractable scaling, learned compression, or superiority in a trained model."
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
        out = Path(args.output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
