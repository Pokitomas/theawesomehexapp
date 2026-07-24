#!/usr/bin/env python3
"""Endogenous hypothesis engine.

The learner receives raw observations and chooses interventions. The environment
returns only the next observation: no task IDs, answers, difficulty labels, or
curriculum menu. A population of independently initialized world models acts as a
neural hypothesis set. Disagreement proposes experiments; observed consequences
revise every hypothesis through gradient descent.

A stronger external teacher is not admitted here. Teacher entry is unlocked only
if endogenous experimentation beats matched random exploration, learns withheld
multi-step consequences, and adapts after the world's causal law changes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
from dataclasses import asdict, dataclass
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-endogenous-hypothesis-engine/v1"


@dataclass(frozen=True)
class Config:
    variables: int = 8
    actions: int = 8
    ensemble: int = 5
    width: int = 96
    latent: int = 24
    bootstrap_steps: int = 96
    autonomous_rounds: int = 16
    experiments_per_round: int = 32
    candidate_actions: int = 64
    updates_per_round: int = 80
    batch_size: int = 64
    replay_capacity: int = 12000
    lr: float = 7e-4
    eval_states: int = 512
    seeds: tuple[int, ...] = (17, 29, 43)
    device: str = "cuda"


class CausalWorld:
    """Continuous nonlinear system exposed only through reset/observe/intervene."""

    def __init__(self, cfg: Config, seed: int, regime: int = 0) -> None:
        g = torch.Generator().manual_seed(seed + regime * 100003)
        raw = torch.randn(cfg.variables, cfg.variables, generator=g) * 0.35
        self.matrix = torch.tril(raw, diagonal=-1)
        self.bias = torch.randn(cfg.variables, generator=g) * 0.12
        self.action_map = torch.randn(cfg.actions, cfg.variables, generator=g) * 0.55
        self.state = torch.zeros(cfg.variables)
        self.cfg = cfg

    def reset(self, seed: int) -> torch.Tensor:
        g = torch.Generator().manual_seed(seed)
        self.state = torch.randn(self.cfg.variables, generator=g) * 0.5
        return self.state.clone()

    def intervene(self, action: int) -> torch.Tensor:
        drive = self.action_map[action]
        propagated = self.matrix @ self.state
        self.state = torch.tanh(0.58 * self.state + propagated + drive + self.bias)
        return self.state.clone()

    def clone_transition(self, states: torch.Tensor, actions: torch.Tensor) -> torch.Tensor:
        drive = self.action_map.index_select(0, actions)
        propagated = states @ self.matrix.T
        return torch.tanh(0.58 * states + propagated + drive + self.bias)


class Hypothesis(nn.Module):
    def __init__(self, cfg: Config) -> None:
        super().__init__()
        self.state_encoder = nn.Sequential(nn.Linear(cfg.variables, cfg.width), nn.GELU())
        self.action = nn.Embedding(cfg.actions, cfg.width)
        self.latent = nn.Sequential(nn.Linear(cfg.width * 2, cfg.latent), nn.Tanh())
        self.decoder = nn.Sequential(
            nn.Linear(cfg.latent, cfg.width), nn.GELU(), nn.Linear(cfg.width, cfg.variables)
        )

    def forward(self, state: torch.Tensor, action: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        joined = torch.cat((self.state_encoder(state), self.action(action)), dim=-1)
        concept = self.latent(joined)
        return self.decoder(concept), concept


class Replay:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.rows: list[tuple[torch.Tensor, int, torch.Tensor]] = []

    def add(self, state: torch.Tensor, action: int, next_state: torch.Tensor) -> None:
        self.rows.append((state.detach().cpu(), int(action), next_state.detach().cpu()))
        if len(self.rows) > self.capacity:
            self.rows = self.rows[-self.capacity:]

    def sample(self, count: int, rng: random.Random, device: torch.device):
        chosen = [self.rows[rng.randrange(len(self.rows))] for _ in range(count)]
        return (
            torch.stack([x[0] for x in chosen]).to(device),
            torch.tensor([x[1] for x in chosen], dtype=torch.long, device=device),
            torch.stack([x[2] for x in chosen]).to(device),
        )


@torch.no_grad()
def choose_action(models: list[Hypothesis], state: torch.Tensor, cfg: Config, rng: random.Random) -> int:
    device = next(models[0].parameters()).device
    actions = torch.tensor(
        [rng.randrange(cfg.actions) for _ in range(cfg.candidate_actions)],
        dtype=torch.long,
        device=device,
    )
    states = state.to(device).unsqueeze(0).expand(actions.numel(), -1)
    predictions = torch.stack([model(states, actions)[0] for model in models])
    disagreement = predictions.var(0, unbiased=False).mean(-1)
    return int(actions[disagreement.argmax()].item())


def update(models: list[Hypothesis], optimizers, replay: Replay, cfg: Config, rng: random.Random) -> float:
    device = next(models[0].parameters()).device
    state, action, target = replay.sample(cfg.batch_size, rng, device)
    losses = []
    for model, optimizer in zip(models, optimizers):
        prediction, concept = model(state, action)
        # Diversity is maintained through bootstrap resampling, not a fabricated label.
        indices = torch.randint(0, state.size(0), (state.size(0),), device=device)
        loss = F.mse_loss(prediction.index_select(0, indices), target.index_select(0, indices))
        loss = loss + 1e-4 * concept.square().mean()
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
    return sum(losses) / len(losses)


@torch.no_grad()
def evaluate(models: list[Hypothesis], world: CausalWorld, cfg: Config, seed: int) -> dict[str, float]:
    device = next(models[0].parameters()).device
    g = torch.Generator().manual_seed(seed)
    states = torch.randn(cfg.eval_states, cfg.variables, generator=g) * 0.6
    actions = torch.randint(0, cfg.actions, (cfg.eval_states,), generator=g)
    target1 = world.clone_transition(states, actions)
    predictions1 = torch.stack([
        model(states.to(device), actions.to(device))[0].cpu() for model in models
    ]).mean(0)
    # Withheld two-step consequence: never directly stored as a training label.
    actions2 = torch.randint(0, cfg.actions, (cfg.eval_states,), generator=g)
    target2 = world.clone_transition(target1, actions2)
    prediction2 = torch.stack([
        model(predictions1.to(device), actions2.to(device))[0].cpu() for model in models
    ]).mean(0)
    return {
        "one_step_mse": float(F.mse_loss(predictions1, target1)),
        "two_step_mse": float(F.mse_loss(prediction2, target2)),
        "ensemble_disagreement": float(torch.stack([
            model(states.to(device), actions.to(device))[0].cpu() for model in models
        ]).var(0, unbiased=False).mean()),
    }


def run_agent(cfg: Config, seed: int, active: bool, output: pathlib.Path) -> dict[str, Any]:
    torch.manual_seed(seed)
    rng = random.Random(seed ^ (0xAC71 if active else 0xBAD))
    device = torch.device(cfg.device)
    models = [Hypothesis(cfg).to(device) for _ in range(cfg.ensemble)]
    optimizers = [torch.optim.AdamW(model.parameters(), lr=cfg.lr) for model in models]
    replay = Replay(cfg.replay_capacity)
    world = CausalWorld(cfg, seed ^ 0xCA55, regime=0)
    state = world.reset(seed ^ 0x111)

    for _ in range(cfg.bootstrap_steps):
        action = rng.randrange(cfg.actions)
        next_state = world.intervene(action)
        replay.add(state, action, next_state)
        state = next_state
    for _ in range(cfg.updates_per_round):
        update(models, optimizers, replay, cfg, rng)

    trajectory = [{"round": 0, "regime": 0, **evaluate(models, world, cfg, seed ^ 0x201)}]
    switch_round = cfg.autonomous_rounds // 2
    for round_index in range(1, cfg.autonomous_rounds + 1):
        if round_index == switch_round:
            world = CausalWorld(cfg, seed ^ 0xCA55, regime=1)
            state = world.reset(seed ^ 0x222)
        for _ in range(cfg.experiments_per_round):
            action = choose_action(models, state, cfg, rng) if active else rng.randrange(cfg.actions)
            next_state = world.intervene(action)
            replay.add(state, action, next_state)
            state = next_state
        for _ in range(cfg.updates_per_round):
            update(models, optimizers, replay, cfg, rng)
        trajectory.append({
            "round": round_index,
            "regime": int(round_index >= switch_round),
            **evaluate(models, world, cfg, seed ^ (0x201 + round_index * 97)),
        })

    checkpoint = output / f"{'active' if active else 'random'}-{seed}.pt"
    torch.save({"schema": SCHEMA, "config": asdict(cfg), "models": [m.state_dict() for m in models]}, checkpoint)
    return {
        "seed": seed,
        "mode": "endogenous" if active else "random",
        "trajectory": trajectory,
        "final": trajectory[-1],
        "post_shift_best_two_step": min(row["two_step_mse"] for row in trajectory[switch_round:]),
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    }


def aggregate(cfg: Config, active_runs: list[dict], random_runs: list[dict]) -> dict[str, Any]:
    pairs = list(zip(active_runs, random_runs))
    checks = {
        "endogenous_beats_random_one_step": all(
            a["final"]["one_step_mse"] < r["final"]["one_step_mse"] * 0.90 for a, r in pairs
        ),
        "endogenous_beats_random_two_step": all(
            a["final"]["two_step_mse"] < r["final"]["two_step_mse"] * 0.90 for a, r in pairs
        ),
        "adapts_after_causal_shift": all(
            a["post_shift_best_two_step"] < a["trajectory"][cfg.autonomous_rounds // 2]["two_step_mse"]
            for a in active_runs
        ),
        "withheld_rollout_is_predictive": all(a["final"]["two_step_mse"] < 0.20 for a in active_runs),
    }
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "active_runs": active_runs,
        "random_runs": random_runs,
        "checks": checks,
        "passed_architecture_gate": all(checks.values()),
        "full_teacher_entry": "unlocked" if all(checks.values()) else "prohibited",
        "claim_boundary": (
            "A pass establishes endogenous experiment selection and transferable predictive adaptation "
            "inside this raw causal world. It does not establish open-ended intelligence. A failure "
            "keeps external full-teacher training locked and triggers architecture search."
        ),
    }


def profile(name: str, device: str) -> Config:
    if name == "smoke":
        return Config(ensemble=3, width=48, latent=12, bootstrap_steps=32,
                      autonomous_rounds=4, experiments_per_round=8, candidate_actions=16,
                      updates_per_round=8, batch_size=16, eval_states=64,
                      seeds=(17,), device=device)
    if name == "full":
        return Config(device=device)
    raise ValueError(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    cfg = profile(args.profile, args.device)
    output = pathlib.Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    active = [run_agent(cfg, seed, True, output) for seed in cfg.seeds]
    random_runs = [run_agent(cfg, seed, False, output) for seed in cfg.seeds]
    receipt = aggregate(cfg, active, random_runs)
    path = output / "endogenous-hypothesis-engine.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
