#!/usr/bin/env python3
"""Learn when latent displacement is sufficient and when absolute state is needed.

Two earlier ARCHIE courts deliberately disagree:

* in the translation-like filesystem ecology, a delta-only inverse selector
  generalized better than endpoint+delta across five seeds;
* in the rotational collision ecology, identical displacements can arise from
  different operators, and endpoint context wins decisively.

This court turns the disagreement into machinery.  Two consequence models are
trained without action labels.  A tiny router is then trained only from their
*prediction errors*: it sees delta and predicts whether paying for endpoint
context is worthwhile.  True regime/action labels are withheld from training
and used only for diagnostics.

The intended primitive is therefore "use the smallest statistic that remains
predictively sufficient", not a fixed commitment to either deltas or full
state.  This is still a developmental court, not a production world model.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
ABLATION_PATH = HERE / "operator_delta_ablation.py"


def load_ablation():
    spec = importlib.util.spec_from_file_location("archie_adaptive_sufficiency_ablation", ABLATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {ABLATION_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


A = load_ablation()
CORE = A.CORE


@dataclass
class Sample:
    before: torch.Tensor
    after: torch.Tensor
    regime: str  # grading only


def rotation(theta: float) -> torch.Tensor:
    c, s = math.cos(theta), math.sin(theta)
    return torch.tensor([[c, -s], [s, c]], dtype=torch.float32)


def build_groups(seed: int, translation_groups: int, collision_groups: int) -> list[list[Sample]]:
    rng = random.Random(seed)
    gen = torch.Generator().manual_seed(seed)
    groups: list[list[Sample]] = []

    # Translation-like transitions: displacement is itself a sufficient action
    # statistic and absolute position is nuisance variation.
    translations = (
        torch.tensor([0.85, 0.15]),
        torch.tensor([-0.65, 0.35]),
    )
    for _ in range(translation_groups):
        x = torch.randn(2, generator=gen) * 1.4
        t = translations[rng.randrange(len(translations))]
        groups.append([Sample(x, x + t, "delta_sufficient")])

    # Rotational collisions: for every sampled displacement d, construct one
    # start state for +theta and another for -theta that produce exactly the
    # same d. Delta cannot tell which operator caused the transition.
    theta = math.pi / 3
    q_plus, q_minus = rotation(theta), rotation(-theta)
    eye = torch.eye(2)
    inv_plus = torch.linalg.inv(q_plus - eye)
    inv_minus = torch.linalg.inv(q_minus - eye)
    for _ in range(collision_groups):
        d = torch.randn(2, generator=gen) * 0.9
        d = d + torch.sign(d + 1e-6) * 0.15
        x_plus, x_minus = inv_plus @ d, inv_minus @ d
        groups.append([
            Sample(x_plus, q_plus @ x_plus, "context_required"),
            Sample(x_minus, q_minus @ x_minus, "context_required"),
        ])

    rng.shuffle(groups)
    return groups


def split_groups(groups: list[list[Sample]], train_fraction: float = 0.8) -> tuple[list[Sample], list[Sample]]:
    split = max(1, min(len(groups) - 1, int(len(groups) * train_fraction)))
    train = [sample for group in groups[:split] for sample in group]
    test = [sample for group in groups[split:] for sample in group]
    return train, test


def stack(samples: list[Sample]) -> tuple[torch.Tensor, torch.Tensor, list[str]]:
    return (
        torch.stack([s.before for s in samples]),
        torch.stack([s.after for s in samples]),
        [s.regime for s in samples],
    )


def fit_normalization(before: torch.Tensor, after: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    all_states = torch.cat([before, after], dim=0)
    center = all_states.median(dim=0).values
    mad = (all_states - center).abs().median(dim=0).values
    scale = (1.4826 * mad).clamp_min(1.0)
    return center, scale


def normalize(x: torch.Tensor, center: torch.Tensor, scale: torch.Tensor) -> torch.Tensor:
    return (x - center) / scale


def train_expert(
    before: torch.Tensor,
    after: torch.Tensor,
    *,
    selector: str,
    codes: int,
    epochs: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> nn.Module:
    random.seed(seed)
    torch.manual_seed(seed)
    model = A.AblationCore(before.shape[-1], codes, selector).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    b, a = before.to(device), after.to(device)
    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.10 * progress
        out = model(b, a, temperature)
        forward_loss = F.mse_loss(out["prediction"], a)
        inverse_loss = F.mse_loss(out["recovered"], b)
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
        loss = forward_loss + 0.5 * inverse_loss + 0.02 * entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
    model.eval()
    return model


class SufficiencyRouter(nn.Module):
    def __init__(self, dim: int, width: int = 32):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(dim, width), nn.SiLU(), nn.Linear(width, 1))

    def forward(self, delta: torch.Tensor) -> torch.Tensor:
        return self.net(delta).squeeze(-1)


def sample_error(model: nn.Module, b: torch.Tensor, a: torch.Tensor) -> torch.Tensor:
    out = model(b, a, 0.06)
    forward = ((out["prediction"] - a) ** 2).mean(-1)
    inverse = ((out["recovered"] - b) ** 2).mean(-1)
    return forward + 0.5 * inverse


def train_router(
    delta: torch.Tensor,
    endpoint_error: torch.Tensor,
    delta_error: torch.Tensor,
    *,
    context_margin: float,
    epochs: int,
    lr: float,
    seed: int,
) -> tuple[SufficiencyRouter, dict[str, float]]:
    # No action/regime labels enter this target. Endpoint context is requested
    # only where its measured consequence error wins by more than the cost
    # margin. This makes representation width answer to predictive evidence.
    target = (endpoint_error + context_margin < delta_error).float()
    torch.manual_seed(seed ^ 0x5155)
    router = SufficiencyRouter(delta.shape[-1]).to(delta.device)
    opt = torch.optim.AdamW(router.parameters(), lr=lr, weight_decay=1e-4)
    positive = float(target.sum().item())
    negative = float((1.0 - target).sum().item())
    pos_weight = torch.tensor([negative / max(1.0, positive)], device=delta.device)
    for _ in range(epochs):
        logits = router(delta)
        loss = F.binary_cross_entropy_with_logits(logits, target, pos_weight=pos_weight)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    router.eval()
    return router, {
        "training_context_target_rate": float(target.mean().item()),
        "mean_endpoint_error": float(endpoint_error.mean().item()),
        "mean_delta_error": float(delta_error.mean().item()),
    }


def mse(prediction: torch.Tensor, target: torch.Tensor) -> float:
    return float(F.mse_loss(prediction, target).detach().cpu())


def run_seed(
    seed: int,
    *,
    translation_groups: int,
    collision_groups: int,
    codes: int,
    expert_epochs: int,
    router_epochs: int,
    lr: float,
    device: str,
    context_margin: float,
) -> dict[str, Any]:
    groups = build_groups(seed, translation_groups, collision_groups)
    train_samples, test_samples = split_groups(groups)
    train_b_raw, train_a_raw, _ = stack(train_samples)
    test_b_raw, test_a_raw, test_regime = stack(test_samples)
    center, scale = fit_normalization(train_b_raw, train_a_raw)
    train_b, train_a = normalize(train_b_raw, center, scale), normalize(train_a_raw, center, scale)
    test_b, test_a = normalize(test_b_raw, center, scale), normalize(test_a_raw, center, scale)
    dev = torch.device(device)
    train_b, train_a, test_b, test_a = train_b.to(dev), train_a.to(dev), test_b.to(dev), test_a.to(dev)

    endpoint = train_expert(
        train_b, train_a, selector="endpoint+delta", codes=codes, epochs=expert_epochs,
        lr=lr, seed=seed, device=dev,
    )
    delta = train_expert(
        train_b, train_a, selector="delta-only", codes=codes, epochs=expert_epochs,
        lr=lr, seed=seed, device=dev,
    )

    with torch.no_grad():
        endpoint_train_error = sample_error(endpoint, train_b, train_a)
        delta_train_error = sample_error(delta, train_b, train_a)
    router, router_train = train_router(
        train_a - train_b,
        endpoint_train_error,
        delta_train_error,
        context_margin=context_margin,
        epochs=router_epochs,
        lr=lr,
        seed=seed,
    )

    with torch.no_grad():
        endpoint_out = endpoint(test_b, test_a, 0.06)
        delta_out = delta(test_b, test_a, 0.06)
        context_prob = torch.sigmoid(router(test_a - test_b))
        use_context = context_prob >= 0.5
        adaptive_prediction = torch.where(
            use_context[:, None], endpoint_out["prediction"], delta_out["prediction"]
        )
        adaptive_recovered = torch.where(
            use_context[:, None], endpoint_out["recovered"], delta_out["recovered"]
        )
        endpoint_error = sample_error(endpoint, test_b, test_a)
        delta_error = sample_error(delta, test_b, test_a)
        oracle_context = endpoint_error + context_margin < delta_error
        gate_accuracy = float((use_context == oracle_context).float().mean().cpu())

    translation_mask = torch.tensor([r == "delta_sufficient" for r in test_regime], device=dev)
    collision_mask = ~translation_mask
    context_rate = float(use_context.float().mean().cpu())
    context_on_translation = float(use_context[translation_mask].float().mean().cpu()) if translation_mask.any() else float("nan")
    context_on_collision = float(use_context[collision_mask].float().mean().cpu()) if collision_mask.any() else float("nan")
    adaptive_forward = mse(adaptive_prediction, test_a)
    adaptive_inverse = mse(adaptive_recovered, test_b)
    endpoint_forward = mse(endpoint_out["prediction"], test_a)
    delta_forward = mse(delta_out["prediction"], test_a)

    return {
        "seed": seed,
        "train_rows": len(train_samples),
        "test_rows": len(test_samples),
        "normalization": {"center": center.tolist(), "scale": scale.tolist()},
        "router_train": router_train,
        "gate_oracle_accuracy": gate_accuracy,
        "context_usage_rate": context_rate,
        "context_usage_on_delta_sufficient": context_on_translation,
        "context_usage_on_context_required": context_on_collision,
        "endpoint_test_forward_mse": endpoint_forward,
        "delta_test_forward_mse": delta_forward,
        "adaptive_test_forward_mse": adaptive_forward,
        "adaptive_test_inverse_mse": adaptive_inverse,
        "adaptive_over_endpoint_forward_mse": adaptive_forward / max(1e-12, endpoint_forward),
        "adaptive_over_delta_forward_mse": adaptive_forward / max(1e-12, delta_forward),
        "valid": bool(
            math.isfinite(adaptive_forward)
            and math.isfinite(adaptive_inverse)
            and 0.0 < context_rate < 1.0
        ),
    }


def run_court(
    seeds: list[int],
    *,
    translation_groups: int,
    collision_groups: int,
    codes: int,
    expert_epochs: int,
    router_epochs: int,
    lr: float,
    device: str,
    context_margin: float,
) -> dict[str, Any]:
    runs = [
        run_seed(
            seed,
            translation_groups=translation_groups,
            collision_groups=collision_groups,
            codes=codes,
            expert_epochs=expert_epochs,
            router_epochs=router_epochs,
            lr=lr,
            device=device,
            context_margin=context_margin,
        )
        for seed in seeds
    ]
    ratios_endpoint = [r["adaptive_over_endpoint_forward_mse"] for r in runs]
    ratios_delta = [r["adaptive_over_delta_forward_mse"] for r in runs]
    context_rates = [r["context_usage_rate"] for r in runs]
    collision_routes = [r["context_usage_on_context_required"] for r in runs]
    translation_routes = [r["context_usage_on_delta_sufficient"] for r in runs]
    gate_accuracies = [r["gate_oracle_accuracy"] for r in runs]
    # We do not demand a miracle. The router earns promotion if it reliably
    # beats the cheap delta expert, stays close to the expensive full-context
    # expert, and measurably avoids full context on the sufficient regime.
    passed = bool(
        all(r["valid"] for r in runs)
        and sum(r < 0.75 for r in ratios_delta) >= len(runs) - 1
        and statistics.median(ratios_endpoint) <= 1.20
        and statistics.median(context_rates) <= 0.75
        and statistics.median(collision_routes) >= 0.75
        and statistics.median(translation_routes) <= 0.40
        and statistics.median(gate_accuracies) >= 0.75
    )
    return {
        "schema": "archie-action-latent/adaptive-sufficient-selector-v1",
        "pass": passed,
        "seeds": seeds,
        "runs": runs,
        "median_adaptive_over_endpoint_forward_mse": statistics.median(ratios_endpoint),
        "median_adaptive_over_delta_forward_mse": statistics.median(ratios_delta),
        "median_context_usage_rate": statistics.median(context_rates),
        "median_context_usage_on_context_required": statistics.median(collision_routes),
        "median_context_usage_on_delta_sufficient": statistics.median(translation_routes),
        "median_gate_oracle_accuracy": statistics.median(gate_accuracies),
        "architectural_consequence": (
            "Representation width becomes a controlled variable: default to relative change, and spend absolute-state bandwidth only "
            "where consequence error says the compressed statistic is ambiguous. A future resident version should learn the uncertainty "
            "signal online and charge the router for bytes moved as well as prediction error."
        ),
        "claim_boundary": (
            "PASS means an error-trained router found a cheaper mixed-regime policy on this synthetic court. It does not establish a universal "
            "minimal state representation or prove the router will transfer to language, vision, or the live host without further courts."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="8801,8802,8803")
    parser.add_argument("--translation-groups", type=int, default=480)
    parser.add_argument("--collision-groups", type=int, default=240)
    parser.add_argument("--codes", type=int, default=6)
    parser.add_argument("--expert-epochs", type=int, default=140)
    parser.add_argument("--router-epochs", type=int, default=180)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--context-margin", type=float, default=0.002)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    seeds = [int(x.strip()) for x in args.seeds.split(",") if x.strip()]
    result = run_court(
        seeds,
        translation_groups=args.translation_groups,
        collision_groups=args.collision_groups,
        codes=args.codes,
        expert_epochs=args.expert_epochs,
        router_epochs=args.router_epochs,
        lr=args.lr,
        device=args.device,
        context_margin=args.context_margin,
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
