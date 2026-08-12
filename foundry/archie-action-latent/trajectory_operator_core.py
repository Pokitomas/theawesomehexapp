#!/usr/bin/env python3
"""Learn persistent action operators from repeated consequences, not one-step aliases.

`second_order_action_identity_court.py` gives an exact witness that a fully
observed transition can be compatible with two different invertible operators.
This file turns that negative result into a learned developmental mechanism.

Two fixed unlabeled operators generate trajectories in R^2:

    U(x) = R_90 x
    V(x) = x + (-1, +1)

A one-step inverse model sees (x0,x1) and chooses an affine-isometry bank member
to predict x2.  A trajectory model observes two displacements (d1,d2), chooses
a bank member, and predicts x3.  Surface operator names are never used in
training.  They are retained only after the models are frozen to measure whether
latent codes line up with the hidden intervention family.

The decisive holdout is x0=(1,0): U and V produce the exact same x1=(0,1), so
no deterministic one-step selector can choose different codes there.  Their x2
states diverge.  The trajectory selector gets that missing intervention evidence
and is graded on future prediction, not on reproducing the hidden name.

This is still a tiny court.  Its architectural claim is narrower but stronger:
persistent operator identity should be earned by repeated consequences and
composition, while single-step effects remain provisional aliases.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
CORE_PATH = HERE / "operator_predictive_core.py"


def load_core():
    spec = importlib.util.spec_from_file_location("archie_trajectory_operator_base", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CORE = load_core()

R90 = torch.tensor([[0.0, -1.0], [1.0, 0.0]], dtype=torch.float32)
SHIFT = torch.tensor([-1.0, 1.0], dtype=torch.float32)


def apply_family(x: torch.Tensor, family: int) -> torch.Tensor:
    if family == 0:
        return x @ R90.T.to(x.device)
    if family == 1:
        return x + SHIFT.to(x.device)
    raise ValueError(family)


def trajectory(x0: torch.Tensor, family: int, applications: int = 3) -> list[torch.Tensor]:
    states = [x0]
    for _ in range(applications):
        states.append(apply_family(states[-1], family))
    return states


def dataset(seed: int, rows: int) -> tuple[torch.Tensor, torch.Tensor]:
    gen = torch.Generator().manual_seed(seed)
    xs: list[torch.Tensor] = []
    labels: list[int] = []
    # Balanced family counts.  Keep the exact alias point out of random training
    # so the court is a real extrapolation to the non-identifiable seam.
    for i in range(rows):
        family = i % 2
        x0 = torch.randn(2, generator=gen) * 1.4
        if torch.max(torch.abs(x0 - torch.tensor([1.0, 0.0]))) < 0.08:
            x0 = x0 + torch.tensor([0.31, -0.27])
        states = trajectory(x0, family, 3)
        xs.append(torch.stack(states))
        labels.append(family)
    return torch.stack(xs), torch.tensor(labels, dtype=torch.long)


def robust_scale(states: torch.Tensor) -> float:
    return max(float(torch.sqrt((states * states).mean()).item()), 1e-3)


class OneStepSelector(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim * 3, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, codes),
        )

    def forward(self, x0: torch.Tensor, x1: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([x0, x1, x1 - x0], dim=-1))


class TrajectorySelector(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        # No family label and no hand-coded angle.  Two observed displacements
        # are the raw intervention history.
        self.net = nn.Sequential(
            nn.Linear(dim * 2, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, codes),
        )

    def forward(self, x0: torch.Tensor, x1: torch.Tensor, x2: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([x1 - x0, x2 - x1], dim=-1))


class OneStepCore(nn.Module):
    def __init__(self, dim: int = 2, codes: int = 2):
        super().__init__()
        self.bank = CORE.CayleyActionBank(codes, dim)
        self.selector = OneStepSelector(dim, codes)

    def forward(self, x0: torch.Tensor, x1: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        probs = F.softmax(self.selector(x0, x1) / temperature, dim=-1)
        candidates = self.bank.forward_all(x1)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        return {"probs": probs, "prediction": prediction}


class TrajectoryCore(nn.Module):
    def __init__(self, dim: int = 2, codes: int = 2):
        super().__init__()
        self.bank = CORE.CayleyActionBank(codes, dim)
        self.selector = TrajectorySelector(dim, codes)

    def forward(self, x0: torch.Tensor, x1: torch.Tensor, x2: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        probs = F.softmax(self.selector(x0, x1, x2) / temperature, dim=-1)
        candidates = self.bank.forward_all(x2)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        return {"probs": probs, "prediction": prediction}


def regularized_loss(prediction: torch.Tensor, target: torch.Tensor, probs: torch.Tensor, codes: int) -> torch.Tensor:
    mse = F.mse_loss(prediction, target)
    entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
    usage = probs.mean(0)
    balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / codes))
    return mse + 0.015 * entropy + 0.15 * balance


def train_pair(
    train_states: torch.Tensor,
    *,
    codes: int,
    epochs: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> tuple[OneStepCore, TrajectoryCore]:
    x = train_states.to(device)
    one = OneStepCore(codes=codes).to(device)
    traj = TrajectoryCore(codes=codes).to(device)
    one_opt = torch.optim.AdamW(one.parameters(), lr=lr, weight_decay=1e-4)
    traj_opt = torch.optim.AdamW(traj.parameters(), lr=lr, weight_decay=1e-4)

    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.06 * progress

        one_out = one(x[:, 0], x[:, 1], temperature)
        one_loss = regularized_loss(one_out["prediction"], x[:, 2], one_out["probs"], codes)
        one_opt.zero_grad(set_to_none=True)
        one_loss.backward()
        torch.nn.utils.clip_grad_norm_(one.parameters(), 5.0)
        one_opt.step()

        traj_out = traj(x[:, 0], x[:, 1], x[:, 2], temperature)
        traj_loss = regularized_loss(traj_out["prediction"], x[:, 3], traj_out["probs"], codes)
        traj_opt.zero_grad(set_to_none=True)
        traj_loss.backward()
        torch.nn.utils.clip_grad_norm_(traj.parameters(), 5.0)
        traj_opt.step()

    one.eval()
    traj.eval()
    return one, traj


def assignments_nmi(assignments: list[int], labels: list[int]) -> float:
    return CORE.normalized_mutual_information(assignments, [str(x) for x in labels])


def assignments_purity(assignments: list[int], labels: list[int]) -> float:
    return CORE.purity(assignments, [str(x) for x in labels])


def alias_states(scale: float, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    rows = []
    labels = []
    x0 = torch.tensor([1.0, 0.0])
    for family in (0, 1):
        rows.append(torch.stack(trajectory(x0, family, 3)) / scale)
        labels.append(family)
    return torch.stack(rows).to(device), torch.tensor(labels, dtype=torch.long, device=device)


def run_seed(seed: int, *, rows: int, codes: int, epochs: int, lr: float, device: str) -> dict[str, Any]:
    random.seed(seed)
    torch.manual_seed(seed)
    states, labels = dataset(seed, rows)
    split = int(rows * 0.8)
    train_raw, test_raw = states[:split], states[split:]
    train_labels, test_labels = labels[:split], labels[split:]
    scale = robust_scale(train_raw)
    train_states = train_raw / scale
    test_states = test_raw / scale
    dev = torch.device(device)

    random.seed(seed)
    torch.manual_seed(seed)
    one, traj = train_pair(train_states, codes=codes, epochs=epochs, lr=lr, seed=seed, device=dev)
    test = test_states.to(dev)
    with torch.no_grad():
        one_out = one(test[:, 0], test[:, 1], 0.04)
        traj_out = traj(test[:, 0], test[:, 1], test[:, 2], 0.04)
        one_mse = float(F.mse_loss(one_out["prediction"], test[:, 2]).cpu())
        traj_mse = float(F.mse_loss(traj_out["prediction"], test[:, 3]).cpu())
        one_assign = one_out["probs"].argmax(-1).cpu().tolist()
        traj_assign = traj_out["probs"].argmax(-1).cpu().tolist()

        alias, alias_labels = alias_states(scale, dev)
        alias_one = one(alias[:, 0], alias[:, 1], 0.02)
        alias_traj = traj(alias[:, 0], alias[:, 1], alias[:, 2], 0.02)
        alias_one_mse = float(F.mse_loss(alias_one["prediction"], alias[:, 2]).cpu())
        alias_traj_mse = float(F.mse_loss(alias_traj["prediction"], alias[:, 3]).cpu())
        alias_one_probs = alias_one["probs"].cpu()
        alias_traj_probs = alias_traj["probs"].cpu()
        alias_one_prob_diff = float((alias_one_probs[0] - alias_one_probs[1]).abs().max())
        alias_traj_prob_diff = float((alias_traj_probs[0] - alias_traj_probs[1]).abs().max())

    labels_list = test_labels.tolist()
    return {
        "seed": seed,
        "scale": scale,
        "test_one_step_next_state_mse": one_mse,
        "test_trajectory_future_state_mse": traj_mse,
        "test_one_step_effect_nmi_grading_only": assignments_nmi(one_assign, labels_list),
        "test_trajectory_effect_nmi_grading_only": assignments_nmi(traj_assign, labels_list),
        "test_one_step_effect_purity_grading_only": assignments_purity(one_assign, labels_list),
        "test_trajectory_effect_purity_grading_only": assignments_purity(traj_assign, labels_list),
        "alias_one_step_next_state_mse": alias_one_mse,
        "alias_trajectory_future_state_mse": alias_traj_mse,
        "alias_one_step_probability_max_abs_diff": alias_one_prob_diff,
        "alias_trajectory_probability_max_abs_diff": alias_traj_prob_diff,
        "alias_one_step_probabilities": alias_one_probs.tolist(),
        "alias_trajectory_probabilities": alias_traj_probs.tolist(),
        "one_step_operator_orthogonality_max_abs_error": one.bank.orthogonality_error(),
        "trajectory_operator_orthogonality_max_abs_error": traj.bank.orthogonality_error(),
        "valid": bool(
            math.isfinite(one_mse)
            and math.isfinite(traj_mse)
            and alias_one_prob_diff <= 1e-7
            and one.bank.orthogonality_error() < 1e-4
            and traj.bank.orthogonality_error() < 1e-4
        ),
    }


def run_court(seeds: list[int], *, rows: int, codes: int, epochs: int, lr: float, device: str) -> dict[str, Any]:
    runs = [run_seed(seed, rows=rows, codes=codes, epochs=epochs, lr=lr, device=device) for seed in seeds]
    alias_one = [r["alias_one_step_next_state_mse"] for r in runs]
    alias_traj = [r["alias_trajectory_future_state_mse"] for r in runs]
    traj_nmi = [r["test_trajectory_effect_nmi_grading_only"] for r in runs]
    traj_purity = [r["test_trajectory_effect_purity_grading_only"] for r in runs]
    ratios = [t / max(o, 1e-12) for t, o in zip(alias_traj, alias_one)]
    passed = bool(
        all(r["valid"] for r in runs)
        and all(r["alias_one_step_probability_max_abs_diff"] <= 1e-7 for r in runs)
        and statistics.median(ratios) <= 0.35
        and statistics.median(traj_nmi) >= 0.80
        and statistics.median(traj_purity) >= 0.90
        and sum(r["alias_trajectory_probability_max_abs_diff"] >= 0.5 for r in runs) >= len(runs) - 1
    )
    return {
        "schema": "archie-action-latent/trajectory-operator-core-court-v1",
        "pass": passed,
        "seeds": seeds,
        "runs": runs,
        "median_alias_trajectory_over_one_step_mse": statistics.median(ratios),
        "median_trajectory_effect_nmi_grading_only": statistics.median(traj_nmi),
        "median_trajectory_effect_purity_grading_only": statistics.median(traj_purity),
        "architectural_consequence": (
            "Persistent action identity is now a trajectory object. The one-step lane records local displacement/effect; a slower intervention lane consolidates an operator only after repeated consequences support a stable compositional hypothesis. "
            "This prevents a larger one-step encoder from hiding causal non-identifiability behind more parameters."
        ),
        "next_escalation": (
            "Force two-step aliases between distinct operators, then require three-step/interventional discrimination. Treat required intervention order as an empirical complexity variable and compress only after identifiability is earned."
        ),
        "claim_boundary": (
            "PASS means a two-displacement latent selector learned future-predictive operator structure for this two-operator court and resolved the exact one-step alias. It does not establish general system identification or planning."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="13001,13002,13003")
    parser.add_argument("--rows", type=int, default=1200)
    parser.add_argument("--codes", type=int, default=2)
    parser.add_argument("--epochs", type=int, default=260)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(
        [int(x.strip()) for x in args.seeds.split(",") if x.strip()],
        rows=args.rows,
        codes=args.codes,
        epochs=args.epochs,
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
