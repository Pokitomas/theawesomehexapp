#!/usr/bin/env python3
"""Counterexample-guided feature synthesis under coordinate-frame randomization.

The first relational-lift court found that one scalar can repair delta-only
ambiguity, but on a fixed coordinate frame its validation search often chose x0
or y0. Those are cheap, yet they are coordinate accidents rather than invariant
relations. This court attacks that success.

Every +/- rotation pair is independently conjugated by a random global 2-D
rotation. The physical transition is unchanged up to coordinates; x0/y0 cease
to be stable identifiers, while rotation-invariant relations such as
cross(z0,d), dot(z0,d), ||z0||^2 and radial change survive. Feature selection
still sees no action/effect labels: candidates are ranked only by held-out
consequence prediction.

If an invariant scalar wins repeatedly, the useful result is not "cross product
is cognition". It is a developmental rule: preserve a cheap feature only if it
survives nuisance-group counterexamples while closing predictive error.
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

HERE = Path(__file__).resolve().parent
LIFT_PATH = HERE / "counterexample_guided_relational_lift.py"


def load_lift():
    spec = importlib.util.spec_from_file_location("archie_invariant_relational_base", LIFT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {LIFT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


L = load_lift()
A = L.A


@dataclass
class Sample:
    before: torch.Tensor
    after: torch.Tensor
    effect: str  # grading only
    frame_angle: float


def rotation(theta: float) -> torch.Tensor:
    c, s = math.cos(theta), math.sin(theta)
    return torch.tensor([[c, -s], [s, c]], dtype=torch.float32)


def build_random_frame_groups(seed: int, pairs: int, theta: float) -> list[list[Sample]]:
    rng = random.Random(seed)
    gen = torch.Generator().manual_seed(seed)
    q_plus, q_minus = rotation(theta), rotation(-theta)
    eye = torch.eye(2)
    inv_plus = torch.linalg.inv(q_plus - eye)
    inv_minus = torch.linalg.inv(q_minus - eye)
    groups: list[list[Sample]] = []
    for _ in range(pairs):
        d = torch.randn(2, generator=gen) * 0.9
        d = d + torch.sign(d + 1e-6) * 0.12
        x_plus = inv_plus @ d
        x_minus = inv_minus @ d

        # New nuisance frame for every paired displacement. Because 2-D
        # rotations commute, S R_theta x == R_theta S x; this is exactly a
        # coordinate change, not a changed action law.
        phi = rng.uniform(-math.pi, math.pi)
        s = rotation(phi)
        xp, ap = s @ x_plus, s @ (q_plus @ x_plus)
        xm, am = s @ x_minus, s @ (q_minus @ x_minus)
        groups.append([
            Sample(xp, ap, "rot_plus", phi),
            Sample(xm, am, "rot_minus", phi),
        ])
    rng.shuffle(groups)
    return groups


def split(groups: list[list[Sample]]) -> tuple[list[Sample], list[Sample], list[Sample]]:
    n = len(groups)
    a = max(1, int(0.60 * n))
    b = max(a + 1, int(0.80 * n))
    b = min(n - 1, b)
    return (
        [s for g in groups[:a] for s in g],
        [s for g in groups[a:b] for s in g],
        [s for g in groups[b:] for s in g],
    )


def stack(rows: list[Sample]):
    return (
        torch.stack([r.before for r in rows]),
        torch.stack([r.after for r in rows]),
        [r.effect for r in rows],
    )


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
    groups = build_random_frame_groups(seed, pairs, theta)
    train_rows, val_rows, test_rows = split(groups)
    train_b0, train_a0, _ = stack(train_rows)
    val_b0, val_a0, _ = stack(val_rows)
    test_b0, test_a0, labels = stack(test_rows)
    scale = L.fit_origin_preserving_scale(train_b0, train_a0)
    dev = torch.device(device)
    train_b, train_a = (train_b0 / scale).to(dev), (train_a0 / scale).to(dev)
    val_b, val_a = (val_b0 / scale).to(dev), (val_a0 / scale).to(dev)
    test_b, test_a = (test_b0 / scale).to(dev), (test_a0 / scale).to(dev)

    search: list[dict[str, Any]] = []
    for index, features in enumerate([()] + [(name,) for name in L.CANDIDATES]):
        model = L.train_relational(
            train_b,
            train_a,
            features=features,
            codes=codes,
            epochs=search_epochs,
            lr=lr,
            seed=seed ^ (index * 0x9E37),
            device=dev,
        )
        search.append({
            "features": list(features),
            "input_dim": 2 + len(features),
            "validation_forward_mse": L.forward_mse(model, val_b, val_a),
        })

    lifted = [row for row in search if row["features"]]
    winner = min(lifted, key=lambda row: row["validation_forward_mse"])
    selected = tuple(winner["features"])
    full_b, full_a = torch.cat([train_b, val_b]), torch.cat([train_a, val_a])

    delta = L.train_relational(
        full_b, full_a, features=(), codes=codes, epochs=final_epochs,
        lr=lr, seed=seed ^ 0xD311A, device=dev,
    )
    lift = L.train_relational(
        full_b, full_a, features=selected, codes=codes, epochs=final_epochs,
        lr=lr, seed=seed ^ 0xD311A, device=dev,
    )
    endpoint = A.AblationCore(2, codes, "endpoint+delta").to(dev)
    torch.manual_seed(seed ^ 0xD311A)
    opt = torch.optim.AdamW(endpoint.parameters(), lr=lr, weight_decay=1e-4)
    import torch.nn.functional as F
    for epoch in range(final_epochs):
        progress = epoch / max(1, final_epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.08 * progress
        out = endpoint(full_b, full_a, temperature)
        fwd = F.mse_loss(out["prediction"], full_a)
        inv = F.mse_loss(out["recovered"], full_b)
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
        loss = fwd + 0.5 * inv + 0.02 * entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(endpoint.parameters(), 5.0)
        opt.step()
    endpoint.eval()

    df = L.forward_mse(delta, test_b, test_a)
    lf = L.forward_mse(lift, test_b, test_a)
    ef = L.forward_mse(endpoint, test_b, test_a)
    diag = L.assignment_diagnostics(lift, test_b, test_a, labels)
    invariant = selected[0] in {"cross", "dot", "radial", "norm0"}
    return {
        "seed": seed,
        "selected_features": list(selected),
        "selected_is_rotation_invariant": invariant,
        "search": sorted(search, key=lambda row: row["validation_forward_mse"]),
        "delta_test_forward_mse": df,
        "lift_test_forward_mse": lf,
        "endpoint_test_forward_mse": ef,
        "lift_over_delta_forward_mse": lf / max(1e-12, df),
        "lift_over_endpoint_forward_mse": lf / max(1e-12, ef),
        "effect_nmi_grading_only": diag["effect_nmi_grading_only"],
        "effect_purity_grading_only": diag["effect_purity_grading_only"],
        "input_width_lift": 3,
        "input_width_endpoint_delta": 6,
        "valid": bool(math.isfinite(lf) and diag["used_codes"] >= 2),
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
            seed, pairs=pairs, theta=theta, codes=codes,
            search_epochs=search_epochs, final_epochs=final_epochs,
            lr=lr, device=device,
        ) for seed in seeds
    ]
    invariant_wins = sum(r["selected_is_rotation_invariant"] for r in runs)
    cross_wins = sum(r["selected_features"] == ["cross"] for r in runs)
    ratios_delta = [r["lift_over_delta_forward_mse"] for r in runs]
    ratios_endpoint = [r["lift_over_endpoint_forward_mse"] for r in runs]
    nmis = [r["effect_nmi_grading_only"] for r in runs]
    passed = bool(
        all(r["valid"] for r in runs)
        and invariant_wins >= len(runs) - 1
        and statistics.median(ratios_delta) <= 0.25
        and statistics.median(ratios_endpoint) <= 1.20
        and statistics.median(nmis) >= 0.60
    )
    return {
        "schema": "archie-action-latent/invariant-relational-synthesis-v1",
        "pass": passed,
        "seeds": seeds,
        "runs": runs,
        "invariant_feature_wins": invariant_wins,
        "cross_feature_wins": cross_wins,
        "median_lift_over_delta_forward_mse": statistics.median(ratios_delta),
        "median_lift_over_endpoint_forward_mse": statistics.median(ratios_endpoint),
        "median_effect_nmi_grading_only": statistics.median(nmis),
        "architectural_consequence": (
            "Counterexample-guided state growth should also quotient nuisance symmetries: add the cheapest relation that remains predictive "
            "under coordinate/frame perturbations, not the cheapest coordinate shortcut in one laboratory frame."
        ),
        "claim_boundary": (
            "PASS would establish only that held-out consequence selection preferred a rotation-invariant one-scalar lift in this randomized-frame "
            "paired-rotation ecology. It would not prove automated invariant discovery in arbitrary groups or domains."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="10101,10102,10103")
    parser.add_argument("--pairs", type=int, default=360)
    parser.add_argument("--theta", type=float, default=math.pi / 3)
    parser.add_argument("--codes", type=int, default=4)
    parser.add_argument("--search-epochs", type=int, default=90)
    parser.add_argument("--final-epochs", type=int, default=140)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    seeds = [int(x.strip()) for x in args.seeds.split(",") if x.strip()]
    result = run_court(
        seeds, pairs=args.pairs, theta=args.theta, codes=args.codes,
        search_epochs=args.search_epochs, final_epochs=args.final_epochs,
        lr=args.lr, device=args.device,
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
