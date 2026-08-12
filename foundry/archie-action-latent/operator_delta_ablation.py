#!/usr/bin/env python3
"""Matched endpoint+delta versus delta-only inverse-dynamics ablation.

This does not promote displacement-only action inference. It asks a narrower
question: with the same consequence ledger, latent operator bank, split, seed,
optimizer, and training schedule, how much predictive structure is lost or
gained when the action selector sees only z1-z0 rather than both endpoints.

The experiment is motivated by action-sensitive latent-difference work, but the
verdict is empirical and local to ARCHIE's motor world.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import sys
import tempfile
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
CORE_PATH = HERE / "operator_predictive_core.py"


def load_core():
    spec = importlib.util.spec_from_file_location("archie_operator_core_for_delta_ablation", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CORE = load_core()


class EndpointDeltaInverse(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim * 3, width), nn.SiLU(), nn.Linear(width, width), nn.SiLU(), nn.Linear(width, codes)
        )

    def forward(self, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([z0, z1, z1 - z0], dim=-1))


class DeltaOnlyInverse(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim, width), nn.SiLU(), nn.Linear(width, width), nn.SiLU(), nn.Linear(width, codes)
        )

    def forward(self, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
        return self.net(z1 - z0)


class AblationCore(nn.Module):
    def __init__(self, dim: int, codes: int, selector: str, width: int = 64):
        super().__init__()
        self.bank = CORE.CayleyActionBank(codes, dim)
        if selector == "endpoint+delta":
            self.inverse = EndpointDeltaInverse(dim, codes, width)
        elif selector == "delta-only":
            self.inverse = DeltaOnlyInverse(dim, codes, width)
        else:
            raise ValueError(selector)

    def forward(self, z0: torch.Tensor, z1: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        logits = self.inverse(z0, z1)
        probs = F.softmax(logits / temperature, dim=-1)
        candidates = self.bank.forward_all(z0)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        inverse_candidates = self.bank.inverse_all(z1)
        recovered = torch.einsum("bk,bkd->bd", probs, inverse_candidates)
        return {"logits": logits, "probs": probs, "prediction": prediction, "recovered": recovered}


def train_variant(
    b: torch.Tensor,
    a: torch.Tensor,
    baseline_code: list[str],
    *,
    selector: str,
    codes: int,
    epochs: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> dict[str, Any]:
    random.seed(seed)
    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)
    b = b.to(device)
    a = a.to(device)
    n, dim = b.shape
    split = max(1, min(n - 1, int(n * 0.8)))
    train_idx = torch.arange(0, split, device=device)
    test_idx = torch.arange(split, n, device=device)
    model = AblationCore(dim, codes, selector).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    losses: list[float] = []

    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.12 * progress
        out = model(b[train_idx], a[train_idx], temperature)
        forward_loss = F.mse_loss(out["prediction"], a[train_idx])
        inverse_loss = F.mse_loss(out["recovered"], b[train_idx])
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
        loss = forward_loss + 0.5 * inverse_loss + 0.02 * entropy + 0.2 * balance
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        optimizer.step()
        losses.append(float(loss.detach().cpu()))

    model.eval()
    with torch.no_grad():
        train_out = model(b[train_idx], a[train_idx], 0.08)
        test_out = model(b[test_idx], a[test_idx], 0.08)
        assignments = model.inverse(b, a).argmax(-1).cpu().tolist()
        result = {
            "selector": selector,
            "selector_input_dim": dim * 3 if selector == "endpoint+delta" else dim,
            "loss_initial": losses[0],
            "loss_final": losses[-1],
            "train_forward_mse": float(F.mse_loss(train_out["prediction"], a[train_idx]).cpu()),
            "test_forward_mse": float(F.mse_loss(test_out["prediction"], a[test_idx]).cpu()),
            "test_inverse_mse": float(F.mse_loss(test_out["recovered"], b[test_idx]).cpu()),
            "used_codes": len(set(assignments)),
            "latent_vs_hand_effect_nmi": CORE.normalized_mutual_information(assignments, baseline_code),
            "latent_vs_hand_effect_purity": CORE.purity(assignments, baseline_code),
            "operator_orthogonality_max_abs_error": model.bank.orthogonality_error(),
        }
    result["valid"] = bool(
        result["loss_final"] < result["loss_initial"]
        and math.isfinite(result["test_forward_mse"])
        and math.isfinite(result["test_inverse_mse"])
        and result["used_codes"] >= 2
        and result["operator_orthogonality_max_abs_error"] < 1e-4
    )
    return result


def run_ablation(
    ledger: Path,
    *,
    codes: int = 8,
    epochs: int = 120,
    lr: float = 3e-3,
    seed: int = 5601,
    device: str = "cpu",
) -> dict[str, Any]:
    rows = CORE.load_rows(ledger)
    before, after, _, baseline_code = CORE.reconstruct_state_pairs(rows)
    before, after, normalization = CORE.robust_normalize(before, after)
    dev = torch.device(device)
    endpoint = train_variant(
        before, after, baseline_code,
        selector="endpoint+delta", codes=codes, epochs=epochs, lr=lr, seed=seed, device=dev,
    )
    delta = train_variant(
        before, after, baseline_code,
        selector="delta-only", codes=codes, epochs=epochs, lr=lr, seed=seed, device=dev,
    )
    eps = 1e-12
    forward_ratio = delta["test_forward_mse"] / max(eps, endpoint["test_forward_mse"])
    inverse_ratio = delta["test_inverse_mse"] / max(eps, endpoint["test_inverse_mse"])
    if forward_ratio <= 1.02 and inverse_ratio <= 1.02:
        verdict = "DELTA_ONLY_TIES_OR_WINS"
    elif forward_ratio <= 1.25 and inverse_ratio <= 1.25:
        verdict = "DELTA_ONLY_SMALL_COST"
    else:
        verdict = "KEEP_ENDPOINT_CONTEXT"
    return {
        "schema": "archie-action-latent/operator-delta-ablation-v1",
        "ledger": str(ledger),
        "rows": len(rows),
        "codes": codes,
        "epochs": epochs,
        "seed": seed,
        "device": str(dev),
        "normalization": normalization,
        "endpoint_delta": endpoint,
        "delta_only": delta,
        "delta_over_endpoint_test_forward_mse": forward_ratio,
        "delta_over_endpoint_test_inverse_mse": inverse_ratio,
        "verdict": verdict,
        "pass": bool(endpoint["valid"] and delta["valid"]),
        "claim_boundary": (
            "PASS means both matched selectors trained and yielded finite non-collapsed held-out measurements. "
            "The verdict chooses no production architecture by itself."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger")
    parser.add_argument("--steps", type=int, default=600)
    parser.add_argument("--codes", type=int, default=8)
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--seed", type=int, default=5601)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()

    temporary = None
    if args.ledger:
        ledger = Path(args.ledger).expanduser().resolve()
    else:
        temporary = tempfile.TemporaryDirectory(prefix="archie-delta-ablation-")
        root = Path(temporary.name)
        ledger = root / "motor.jsonl"
        motor = CORE.load_motor_module()
        motor.run_court(root / "world", ledger, args.steps, args.seed)

    result = run_ablation(
        ledger, codes=args.codes, epochs=args.epochs, lr=args.lr, seed=args.seed, device=args.device
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        out = Path(args.output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", "utf-8")
    print(text)
    if temporary is not None:
        temporary.cleanup()
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
