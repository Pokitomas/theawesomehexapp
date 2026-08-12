#!/usr/bin/env python3
"""Counterexample-guided synthesis of a cheaper sufficient action statistic.

ARCHIE's preceding courts found a useful contradiction:

* displacement alone generalizes well in a translation-like filesystem ecology;
* displacement alone is provably ambiguous in a paired +/- rotation ecology,
  where identical deltas can come from different latent operators.

The failed adaptive router taught a sharper lesson: a router that only sees the
compressed statistic cannot reliably know when that statistic has destroyed the
very information needed to route.  Rather than immediately buying the entire
endpoint state, this court asks whether one *relational scalar* can repair the
counterexample.

Candidate lifts are generated from z0 and d=z1-z0.  Their names are not action
labels and no hand-coded operator identity enters optimization.  Each candidate
is judged only by held-out consequence prediction.  The smallest winning lift
is then retrained and compared with delta-only and the expensive
endpoint+delta selector.

For the paired rotation ecology, cross(z0,d) is mathematically interesting:

    cross(z0, (R_theta-I)z0) = ||z0||^2 sin(theta)

so its sign distinguishes +theta from -theta even when d is identical.  The
court does not force the search to select it; selection is by validation error.
If a cheaper relation wins, that is evidence for counterexample-guided feature
synthesis, not a claim of universal representation learning.
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
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
ABLATION_PATH = HERE / "operator_delta_ablation.py"


def load_ablation():
    spec = importlib.util.spec_from_file_location("archie_relational_lift_ablation", ABLATION_PATH)
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
    effect: str  # grading only; never used by training or feature selection


def rotation(theta: float) -> torch.Tensor:
    c, s = math.cos(theta), math.sin(theta)
    return torch.tensor([[c, -s], [s, c]], dtype=torch.float32)


def build_collision_groups(seed: int, pairs: int, theta: float) -> list[list[Sample]]:
    """Make paired samples whose deltas match but whose operators differ."""
    rng = random.Random(seed)
    gen = torch.Generator().manual_seed(seed)
    q_plus = rotation(theta)
    q_minus = rotation(-theta)
    eye = torch.eye(2)
    inv_plus = torch.linalg.inv(q_plus - eye)
    inv_minus = torch.linalg.inv(q_minus - eye)
    groups: list[list[Sample]] = []
    for _ in range(pairs):
        d = torch.randn(2, generator=gen) * 0.9
        # Keep the displacement away from the singularly boring origin while
        # preserving a continuous distribution across held-out groups.
        d = d + torch.sign(d + 1e-6) * 0.12
        x_plus = inv_plus @ d
        x_minus = inv_minus @ d
        groups.append([
            Sample(x_plus, q_plus @ x_plus, "rot_plus"),
            Sample(x_minus, q_minus @ x_minus, "rot_minus"),
        ])
    rng.shuffle(groups)
    return groups


def split_groups(groups: list[list[Sample]]) -> tuple[list[Sample], list[Sample], list[Sample]]:
    """Split by paired displacement so identical-delta twins never leak."""
    n = len(groups)
    n_train = max(1, int(n * 0.65))
    n_val = max(1, int(n * 0.17))
    if n_train + n_val >= n:
        n_val = max(1, n - n_train - 1)
    train = [s for g in groups[:n_train] for s in g]
    val = [s for g in groups[n_train:n_train + n_val] for s in g]
    test = [s for g in groups[n_train + n_val:] for s in g]
    return train, val, test


def stack(samples: Iterable[Sample]) -> tuple[torch.Tensor, torch.Tensor, list[str]]:
    rows = list(samples)
    return (
        torch.stack([x.before for x in rows]),
        torch.stack([x.after for x in rows]),
        [x.effect for x in rows],
    )


def fit_origin_preserving_scale(before: torch.Tensor, after: torch.Tensor) -> float:
    """Use one scalar scale; do not translate the origin and destroy rotation invariants."""
    all_states = torch.cat([before, after], dim=0)
    rms = float(torch.sqrt((all_states * all_states).mean()).item())
    return max(rms, 1e-3)


CANDIDATES = ("cross", "dot", "radial", "norm0", "x0", "y0")


def feature_tensor(z0: torch.Tensor, z1: torch.Tensor, names: tuple[str, ...]) -> torch.Tensor:
    d = z1 - z0
    pieces = [d]
    for name in names:
        if name == "cross":
            value = z0[:, 0] * d[:, 1] - z0[:, 1] * d[:, 0]
        elif name == "dot":
            value = (z0 * d).sum(-1)
        elif name == "radial":
            value = (z1 * z1).sum(-1) - (z0 * z0).sum(-1)
        elif name == "norm0":
            value = (z0 * z0).sum(-1)
        elif name == "x0":
            value = z0[:, 0]
        elif name == "y0":
            value = z0[:, 1]
        else:
            raise ValueError(name)
        pieces.append(value[:, None])
    return torch.cat(pieces, dim=-1)


class RelationalInverse(nn.Module):
    def __init__(self, dim: int, codes: int, features: tuple[str, ...], width: int = 64):
        super().__init__()
        self.features = features
        input_dim = dim + len(features)
        self.net = nn.Sequential(
            nn.Linear(input_dim, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, codes),
        )

    def forward(self, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
        return self.net(feature_tensor(z0, z1, self.features))


class RelationalCore(nn.Module):
    def __init__(self, dim: int, codes: int, features: tuple[str, ...], width: int = 64):
        super().__init__()
        self.bank = CORE.CayleyActionBank(codes, dim)
        self.inverse = RelationalInverse(dim, codes, features, width)

    def forward(self, z0: torch.Tensor, z1: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        logits = self.inverse(z0, z1)
        probs = F.softmax(logits / temperature, dim=-1)
        candidates = self.bank.forward_all(z0)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        inverse_candidates = self.bank.inverse_all(z1)
        recovered = torch.einsum("bk,bkd->bd", probs, inverse_candidates)
        return {
            "logits": logits,
            "probs": probs,
            "prediction": prediction,
            "recovered": recovered,
        }


def train_relational(
    before: torch.Tensor,
    after: torch.Tensor,
    *,
    features: tuple[str, ...],
    codes: int,
    epochs: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> RelationalCore:
    random.seed(seed)
    torch.manual_seed(seed)
    model = RelationalCore(before.shape[-1], codes, features).to(device)
    b, a = before.to(device), after.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.08 * progress
        out = model(b, a, temperature)
        fwd = F.mse_loss(out["prediction"], a)
        inv = F.mse_loss(out["recovered"], b)
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
        loss = fwd + 0.5 * inv + 0.02 * entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
    model.eval()
    return model


def forward_mse(model: nn.Module, before: torch.Tensor, after: torch.Tensor) -> float:
    with torch.no_grad():
        out = model(before, after, 0.05)
        return float(F.mse_loss(out["prediction"], after).cpu())


def inverse_mse(model: nn.Module, before: torch.Tensor, after: torch.Tensor) -> float:
    with torch.no_grad():
        out = model(before, after, 0.05)
        return float(F.mse_loss(out["recovered"], before).cpu())


def assignment_diagnostics(model: RelationalCore, before: torch.Tensor, after: torch.Tensor, labels: list[str]) -> dict[str, Any]:
    with torch.no_grad():
        assignments = model.inverse(before, after).argmax(-1).cpu().tolist()
    return {
        "used_codes": len(set(assignments)),
        "effect_nmi_grading_only": CORE.normalized_mutual_information(assignments, labels),
        "effect_purity_grading_only": CORE.purity(assignments, labels),
        "operator_orthogonality_max_abs_error": model.bank.orthogonality_error(),
    }


def run_seed(
    seed: int,
    *,
    pairs: int,
    theta: float,
    codes: int,
    search_epochs: int,
    final_epochs: int,
    lr: float,
    device: str,
) -> dict[str, Any]:
    groups = build_collision_groups(seed, pairs, theta)
    train_rows, val_rows, test_rows = split_groups(groups)
    train_b_raw, train_a_raw, _ = stack(train_rows)
    val_b_raw, val_a_raw, _ = stack(val_rows)
    test_b_raw, test_a_raw, test_labels = stack(test_rows)
    scale = fit_origin_preserving_scale(train_b_raw, train_a_raw)
    train_b, train_a = train_b_raw / scale, train_a_raw / scale
    val_b, val_a = val_b_raw / scale, val_a_raw / scale
    test_b, test_a = test_b_raw / scale, test_a_raw / scale
    dev = torch.device(device)
    train_b, train_a = train_b.to(dev), train_a.to(dev)
    val_b, val_a = val_b.to(dev), val_a.to(dev)
    test_b, test_a = test_b.to(dev), test_a.to(dev)

    search: list[dict[str, Any]] = []
    delta_model = train_relational(
        train_b, train_a, features=(), codes=codes, epochs=search_epochs,
        lr=lr, seed=seed, device=dev,
    )
    delta_val = forward_mse(delta_model, val_b, val_a)
    search.append({"features": [], "input_dim": 2, "validation_forward_mse": delta_val})

    for index, name in enumerate(CANDIDATES):
        model = train_relational(
            train_b, train_a, features=(name,), codes=codes, epochs=search_epochs,
            lr=lr, seed=seed, device=dev,
        )
        score = forward_mse(model, val_b, val_a)
        search.append({"features": [name], "input_dim": 3, "validation_forward_mse": score})

    candidates = [row for row in search if row["features"]]
    winner = min(candidates, key=lambda row: row["validation_forward_mse"])
    selected = tuple(winner["features"])

    # Retrain all final contestants on train+validation using the feature chosen
    # solely from the earlier held-out consequence court.
    full_train_b = torch.cat([train_b, val_b], dim=0)
    full_train_a = torch.cat([train_a, val_a], dim=0)
    delta_final = train_relational(
        full_train_b, full_train_a, features=(), codes=codes, epochs=final_epochs,
        lr=lr, seed=seed ^ 0xD311A, device=dev,
    )
    lift_final = train_relational(
        full_train_b, full_train_a, features=selected, codes=codes, epochs=final_epochs,
        lr=lr, seed=seed ^ 0xD311A, device=dev,
    )
    # Endpoint+delta remains the expensive comparison; it is not part of the
    # feature search and therefore cannot leak a hand label into selection.
    random.seed(seed ^ 0xD311A)
    torch.manual_seed(seed ^ 0xD311A)
    endpoint_final = A.AblationCore(2, codes, "endpoint+delta").to(dev)
    opt = torch.optim.AdamW(endpoint_final.parameters(), lr=lr, weight_decay=1e-4)
    for epoch in range(final_epochs):
        progress = epoch / max(1, final_epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.08 * progress
        out = endpoint_final(full_train_b, full_train_a, temperature)
        fwd = F.mse_loss(out["prediction"], full_train_a)
        inv = F.mse_loss(out["recovered"], full_train_b)
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
        loss = fwd + 0.5 * inv + 0.02 * entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(endpoint_final.parameters(), 5.0)
        opt.step()
    endpoint_final.eval()

    delta_f = forward_mse(delta_final, test_b, test_a)
    lift_f = forward_mse(lift_final, test_b, test_a)
    endpoint_f = forward_mse(endpoint_final, test_b, test_a)
    delta_i = inverse_mse(delta_final, test_b, test_a)
    lift_i = inverse_mse(lift_final, test_b, test_a)
    endpoint_i = inverse_mse(endpoint_final, test_b, test_a)
    diag = assignment_diagnostics(lift_final, test_b, test_a, test_labels)

    return {
        "seed": seed,
        "pairs": pairs,
        "scale": scale,
        "selected_features": list(selected),
        "search": sorted(search, key=lambda row: row["validation_forward_mse"]),
        "delta_test_forward_mse": delta_f,
        "lift_test_forward_mse": lift_f,
        "endpoint_test_forward_mse": endpoint_f,
        "delta_test_inverse_mse": delta_i,
        "lift_test_inverse_mse": lift_i,
        "endpoint_test_inverse_mse": endpoint_i,
        "lift_over_delta_forward_mse": lift_f / max(1e-12, delta_f),
        "lift_over_endpoint_forward_mse": lift_f / max(1e-12, endpoint_f),
        "lift_over_delta_inverse_mse": lift_i / max(1e-12, delta_i),
        "lift_over_endpoint_inverse_mse": lift_i / max(1e-12, endpoint_i),
        "selector_input_dims": {"delta": 2, "lift": 3, "endpoint_delta": 6},
        "lift_width_ratio_vs_endpoint": 3 / 6,
        **diag,
        "valid": bool(
            math.isfinite(lift_f)
            and math.isfinite(lift_i)
            and diag["used_codes"] >= 2
            and diag["operator_orthogonality_max_abs_error"] < 1e-4
        ),
    }


def run_court(
    seeds: list[int],
    *,
    pairs: int,
    theta: float,
    codes: int,
    search_epochs: int,
    final_epochs: int,
    lr: float,
    device: str,
) -> dict[str, Any]:
    runs = [
        run_seed(
            seed,
            pairs=pairs,
            theta=theta,
            codes=codes,
            search_epochs=search_epochs,
            final_epochs=final_epochs,
            lr=lr,
            device=device,
        )
        for seed in seeds
    ]
    lift_delta = [r["lift_over_delta_forward_mse"] for r in runs]
    lift_endpoint = [r["lift_over_endpoint_forward_mse"] for r in runs]
    nmi = [r["effect_nmi_grading_only"] for r in runs]
    selected = [r["selected_features"][0] if r["selected_features"] else "none" for r in runs]
    passed = bool(
        all(r["valid"] for r in runs)
        and statistics.median(lift_delta) <= 0.35
        and statistics.median(lift_endpoint) <= 1.25
        and statistics.median(nmi) >= 0.60
        and sum(r <= 0.50 for r in lift_delta) >= len(runs) - 1
    )
    return {
        "schema": "archie-action-latent/counterexample-guided-relational-lift-v1",
        "pass": passed,
        "seeds": seeds,
        "runs": runs,
        "selected_features": selected,
        "median_lift_over_delta_forward_mse": statistics.median(lift_delta),
        "median_lift_over_endpoint_forward_mse": statistics.median(lift_endpoint),
        "median_effect_nmi_grading_only": statistics.median(nmi),
        "input_width_delta": 2,
        "input_width_lift": 3,
        "input_width_endpoint_delta": 6,
        "architectural_consequence": (
            "When a compressed action statistic fails, do not jump directly to full state. Preserve the counterexample, synthesize cheap relational lifts, "
            "and promote the smallest lift that closes held-out consequence error. This turns representation width into an empirical search variable and "
            "creates a path from fixed feature engineering toward learned counterexample-guided sufficient statistics."
        ),
        "claim_boundary": (
            "PASS means one scalar relation repaired an adversarial paired-rotation ambiguity while using half the selector input width of endpoint+delta in "
            "this court. It does not prove that the same relation is sufficient in other ecologies or that automated candidate synthesis is solved."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="9901,9902,9903")
    parser.add_argument("--pairs", type=int, default=320)
    parser.add_argument("--theta-deg", type=float, default=60.0)
    parser.add_argument("--codes", type=int, default=4)
    parser.add_argument("--search-epochs", type=int, default=90)
    parser.add_argument("--final-epochs", type=int, default=140)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    seeds = [int(x.strip()) for x in args.seeds.split(",") if x.strip()]
    result = run_court(
        seeds,
        pairs=args.pairs,
        theta=math.radians(args.theta_deg),
        codes=args.codes,
        search_epochs=args.search_epochs,
        final_epochs=args.final_epochs,
        lr=args.lr,
        device=args.device,
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
