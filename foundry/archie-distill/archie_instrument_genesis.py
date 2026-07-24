#!/usr/bin/env python3
"""Instrument genesis: evolve executable measurements from raw history.

A candidate instrument is an expression tree over raw sensor and motor history.
The language contains no target concept, hidden simulator variable, world-family
identifier, task label, reward, or privileged callback.

Programs mutate, compose, compete, and retire. Admission requires:
- lower held-out counterfactual prediction error than a raw-current baseline;
- the benefit survives across two independently implemented world families;
- causal ablation (shuffle/zero) damages downstream prediction;
- the instrument improves the full sealed counterfactual intervention surface;
- the program was never evaluated on sealed worlds during evolution.

This is a complete bounded research product, not a finished general intelligence.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import pathlib
import random
from dataclasses import dataclass
from typing import Any, Sequence

import torch
import torch.nn.functional as F

SCHEMA = "archie-instrument-genesis/v3"
OPS = ("add", "sub", "mul", "tanh", "abs", "clip", "mean2")


@dataclass(frozen=True)
class Config:
    sensors: int = 4
    actions: int = 5
    history: int = 4
    train_worlds_per_family: int = 3
    dev_worlds_per_family: int = 2
    sealed_worlds_per_family: int = 3
    trajectories_per_world: int = 48
    steps_per_trajectory: int = 18
    population: int = 80
    generations: int = 28
    elites: int = 12
    max_depth: int = 4
    admitted: int = 3
    ridge: float = 2e-3
    seeds: tuple[int, ...] = (17, 29, 43)
    device: str = "cpu"

    def validate(self) -> None:
        if self.sensors < 4 or self.actions < 3 or self.history < 3:
            raise ValueError("world too small")
        if self.elites >= self.population:
            raise ValueError("elites must be smaller than population")
        if self.admitted < 1:
            raise ValueError("at least one instrument required")


@dataclass(frozen=True)
class Program:
    op: str
    args: tuple[Any, ...]

    def json(self) -> Any:
        return [self.op, *[a.json() if isinstance(a, Program) else a for a in self.args]]

    @classmethod
    def from_json(cls, value: Any) -> "Program":
        op = str(value[0])
        args = tuple(cls.from_json(v) if isinstance(v, list) else v for v in value[1:])
        return cls(op, args)

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(self.json(), separators=(",", ":")).encode()).hexdigest()

    def size(self) -> int:
        return 1 + sum(a.size() if isinstance(a, Program) else 0 for a in self.args)

    def depth(self) -> int:
        children = [a.depth() for a in self.args if isinstance(a, Program)]
        return 1 + (max(children) if children else 0)


@dataclass
class Dataset:
    obs_history: torch.Tensor
    action_history: torch.Tensor
    action: torch.Tensor
    next_obs: torch.Tensor
    world_family: torch.Tensor
    world_id: torch.Tensor

    def to(self, device: torch.device) -> "Dataset":
        return Dataset(*(x.to(device) for x in dataclasses.astuple(self)))


class RawWorld:
    family: int

    def reset(self, seed: int) -> torch.Tensor:
        raise NotImplementedError

    def step(self, action: int) -> torch.Tensor:
        raise NotImplementedError

    def counterfactual(self, state_snapshot: Any, action: int) -> torch.Tensor:
        raise NotImplementedError

    def snapshot(self) -> Any:
        raise NotImplementedError


class InertialWorld(RawWorld):
    family = 0

    def __init__(self, cfg: Config, seed: int) -> None:
        self.cfg = cfg
        g = torch.Generator().manual_seed(seed)
        self.dim = 6
        self.mix = torch.randn(cfg.sensors, self.dim, generator=g)
        q, _ = torch.linalg.qr(self.mix.T, mode="reduced")
        self.mix = q.T
        if self.mix.shape[0] < cfg.sensors:
            self.mix = torch.cat(
                (self.mix, torch.randn(cfg.sensors - self.mix.shape[0], self.dim, generator=g)),
                0,
            )
        self.mix = self.mix[:cfg.sensors]
        self.drive = torch.randn(cfg.actions, self.dim, generator=g) * 0.22
        self.coupling = torch.randn(self.dim, self.dim, generator=g) * 0.08
        self.bias = torch.randn(cfg.sensors, generator=g) * 0.05
        self.pos = torch.zeros(self.dim)
        self.vel = torch.zeros(self.dim)

    def observe(self, pos: torch.Tensor, vel: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.mix @ pos + self.bias)

    def reset(self, seed: int) -> torch.Tensor:
        g = torch.Generator().manual_seed(seed)
        self.pos = torch.randn(self.dim, generator=g) * 0.4
        self.vel = torch.randn(self.dim, generator=g) * 0.18
        return self.observe(self.pos, self.vel)

    def transition(self, pos: torch.Tensor, vel: torch.Tensor, action: int):
        gain = 0.55 + 0.45 * torch.tanh(pos)
        vel2 = (
            0.84 * vel
            + self.drive[action] * gain
            + 0.06 * torch.sin(pos)
            + self.coupling @ pos
        )
        pos2 = pos + vel2
        return pos2, vel2

    def step(self, action: int) -> torch.Tensor:
        self.pos, self.vel = self.transition(self.pos, self.vel, action)
        return self.observe(self.pos, self.vel)

    def snapshot(self) -> Any:
        return (self.pos.clone(), self.vel.clone())

    def counterfactual(self, state_snapshot: Any, action: int) -> torch.Tensor:
        pos, vel = state_snapshot
        p2, v2 = self.transition(pos, vel, action)
        return self.observe(p2, v2)


class OscillatorWorld(RawWorld):
    family = 1

    def __init__(self, cfg: Config, seed: int) -> None:
        self.cfg = cfg
        g = torch.Generator().manual_seed(seed)
        self.dim = 6
        self.spring = 0.12 + torch.rand(self.dim, generator=g) * 0.20
        self.damping = 0.58 + torch.rand(self.dim, generator=g) * 0.20
        coupling = torch.randn(self.dim, self.dim, generator=g) * 0.045
        self.coupling = coupling - torch.diag(torch.diag(coupling))
        self.drive = torch.randn(cfg.actions, self.dim, generator=g) * 0.28
        mix_raw = torch.randn(cfg.sensors, self.dim, generator=g)
        q, _ = torch.linalg.qr(mix_raw.T, mode="reduced")
        self.mix = q.T[:cfg.sensors]
        self.bias = torch.randn(cfg.sensors, generator=g) * 0.04
        self.pos = torch.zeros(self.dim)
        self.vel = torch.zeros(self.dim)

    def observe(self, pos: torch.Tensor, vel: torch.Tensor) -> torch.Tensor:
        curved = pos + 0.18 * torch.sin(2.0 * pos)
        return torch.tanh(self.mix @ curved + self.bias)

    def reset(self, seed: int) -> torch.Tensor:
        g = torch.Generator().manual_seed(seed)
        self.pos = torch.randn(self.dim, generator=g) * 0.55
        self.vel = torch.randn(self.dim, generator=g) * 0.30
        return self.observe(self.pos, self.vel)

    def transition(self, pos: torch.Tensor, vel: torch.Tensor, action: int):
        phase_gain = 0.48 + 0.52 * torch.cos(pos)
        force = (
            -self.spring * torch.sin(pos)
            + self.coupling @ torch.tanh(pos)
            + self.drive[action] * phase_gain
        )
        vel2 = self.damping * vel + force
        pos2 = pos + 0.72 * vel2 + 0.08 * torch.sin(vel2)
        return pos2, vel2

    def step(self, action: int) -> torch.Tensor:
        self.pos, self.vel = self.transition(self.pos, self.vel, action)
        return self.observe(self.pos, self.vel)

    def snapshot(self) -> Any:
        return (self.pos.clone(), self.vel.clone())

    def counterfactual(self, state_snapshot: Any, action: int) -> torch.Tensor:
        pos, vel = state_snapshot
        p2, v2 = self.transition(pos, vel, action)
        return self.observe(p2, v2)


def make_world(cfg: Config, family: int, seed: int) -> RawWorld:
    return InertialWorld(cfg, seed) if family == 0 else OscillatorWorld(cfg, seed)


def collect_world(cfg: Config, family: int, world_seed: int, world_id: int, seed: int) -> Dataset:
    rng = random.Random(seed)
    world = make_world(cfg, family, world_seed)
    oh, ah, ac, no, wf, wi = [], [], [], [], [], []
    for trajectory in range(cfg.trajectories_per_world):
        obs = [world.reset(seed ^ (trajectory * 7919 + world_seed))]
        actions: list[int] = []
        for _ in range(cfg.steps_per_trajectory):
            action = rng.randrange(cfg.actions)
            nxt = world.step(action)
            actions.append(action)
            obs.append(nxt)
            if len(obs) >= cfg.history + 1:
                start = len(obs) - cfg.history - 1
                oh.append(torch.stack(obs[start:start + cfg.history]))
                ah.append(torch.tensor(actions[start:start + cfg.history - 1], dtype=torch.long))
                ac.append(action)
                no.append(nxt)
                wf.append(family)
                wi.append(world_id)
    return Dataset(
        torch.stack(oh),
        torch.stack(ah),
        torch.tensor(ac, dtype=torch.long),
        torch.stack(no),
        torch.tensor(wf, dtype=torch.long),
        torch.tensor(wi, dtype=torch.long),
    )


def concat(parts: Sequence[Dataset]) -> Dataset:
    return Dataset(*(torch.cat(xs, 0) for xs in zip(*(dataclasses.astuple(p) for p in parts))))


def build_splits(cfg: Config, seed: int):
    result = {}
    offset = 0
    for split, count, salt in (
        ("train", cfg.train_worlds_per_family, 1000),
        ("dev", cfg.dev_worlds_per_family, 2000),
    ):
        parts = []
        for family in (0, 1):
            for index in range(count):
                world_seed = seed * 100000 + salt + family * 100 + index
                parts.append(collect_world(cfg, family, world_seed, offset, seed ^ world_seed))
                offset += 1
        result[split] = concat(parts)
    return result


def terminal(rng: random.Random, cfg: Config) -> Program:
    draw = rng.random()
    if draw < 0.72:
        return Program("obs", (rng.randrange(cfg.history),))
    if draw < 0.90:
        return Program("act", (rng.randrange(cfg.history - 1), rng.randrange(cfg.actions)))
    return Program("const", (rng.choice((-1.0, -0.5, 0.0, 0.5, 1.0)),))


def random_program(rng: random.Random, cfg: Config, depth: int | None = None) -> Program:
    depth = cfg.max_depth if depth is None else depth
    if depth <= 0 or rng.random() < 0.28:
        return terminal(rng, cfg)
    op = rng.choice(OPS)
    if op in ("tanh", "abs", "clip"):
        return Program(op, (random_program(rng, cfg, depth - 1),))
    return Program(
        op,
        (random_program(rng, cfg, depth - 1), random_program(rng, cfg, depth - 1)),
    )


def eval_program(program: Program, data: Dataset) -> torch.Tensor:
    op = program.op
    if op == "obs":
        (t,) = program.args
        return data.obs_history[:, int(t)]
    if op == "act":
        t, a = program.args
        scalar = data.action_history[:, int(t)].eq(int(a)).float()
        return scalar.unsqueeze(1).expand(-1, data.obs_history.size(-1))
    if op == "const":
        return torch.full(
            (data.action.numel(), data.obs_history.size(-1)),
            float(program.args[0]),
            device=data.action.device,
        )
    values = [eval_program(a, data) for a in program.args]
    if op == "add":
        out = values[0] + values[1]
    elif op == "sub":
        out = values[0] - values[1]
    elif op == "mul":
        out = values[0] * values[1]
    elif op == "tanh":
        out = torch.tanh(values[0])
    elif op == "abs":
        out = values[0].abs()
    elif op == "clip":
        out = values[0].clamp(-1.5, 1.5)
    elif op == "mean2":
        out = 0.5 * (values[0] + values[1])
    else:
        raise ValueError(op)
    return torch.nan_to_num(out, nan=0.0, posinf=2.0, neginf=-2.0).clamp(-4, 4)


def mutate(program: Program, rng: random.Random, cfg: Config) -> Program:
    if rng.random() < 0.22:
        return random_program(rng, cfg, rng.randrange(cfg.max_depth + 1))
    args = list(program.args)
    child_indices = [i for i, a in enumerate(args) if isinstance(a, Program)]
    if not child_indices:
        return terminal(rng, cfg)
    index = rng.choice(child_indices)
    args[index] = mutate(args[index], rng, cfg)
    result = Program(program.op, tuple(args))
    return result if result.depth() <= cfg.max_depth + 1 else program


def crossover(a: Program, b: Program, rng: random.Random, cfg: Config) -> Program:
    if rng.random() < 0.35:
        return b
    args = list(a.args)
    child_indices = [i for i, x in enumerate(args) if isinstance(x, Program)]
    if not child_indices:
        return b if b.depth() <= cfg.max_depth else a
    i = rng.choice(child_indices)
    args[i] = crossover(args[i], b, rng, cfg)
    result = Program(a.op, tuple(args))
    return result if result.depth() <= cfg.max_depth + 1 else a


def subset(data: Dataset, mask: torch.Tensor) -> Dataset:
    return Dataset(*(x[mask] for x in dataclasses.astuple(data)))


def action_one_hot(action: torch.Tensor, actions: int) -> torch.Tensor:
    return F.one_hot(action, num_classes=actions).float()


def standardize_fit(x: torch.Tensor):
    mean = x.mean(0, keepdim=True)
    scale = x.std(0, keepdim=True).clamp_min(1e-5)
    return mean, scale


def ridge_fit(x: torch.Tensor, y: torch.Tensor, ridge: float):
    ones = torch.ones(x.size(0), 1, device=x.device)
    xx = torch.cat((x, ones), 1)
    eye = torch.eye(xx.size(1), device=x.device)
    eye[-1, -1] = 0
    return torch.linalg.solve(xx.T @ xx + ridge * eye, xx.T @ y)


def ridge_predict(x: torch.Tensor, weights: torch.Tensor):
    return torch.cat((x, torch.ones(x.size(0), 1, device=x.device)), 1) @ weights


def feature_matrix(data: Dataset, cfg: Config, programs: Sequence[Program]) -> torch.Tensor:
    current = data.obs_history[:, -1]
    one_hot = action_one_hot(data.action, cfg.actions)
    if programs:
        inst = torch.cat([eval_program(p, data) for p in programs], 1)
        return torch.cat((current, one_hot, inst), 1)
    return torch.cat((current, one_hot), 1)


def fit_predictor(train: Dataset, cfg: Config, programs: Sequence[Program]):
    x = feature_matrix(train, cfg, programs)
    xm, xs = standardize_fit(x)
    ym, ys = standardize_fit(train.next_obs)
    w = ridge_fit((x - xm) / xs, (train.next_obs - ym) / ys, cfg.ridge)
    return {"xm": xm, "xs": xs, "ym": ym, "ys": ys, "w": w}


def fit_family_predictors(train: Dataset, cfg: Config, programs: Sequence[Program]):
    return {
        family: fit_predictor(subset(train, train.world_family.eq(family)), cfg, programs)
        for family in (0, 1)
    }


def predict(model, data: Dataset, cfg: Config, programs: Sequence[Program], override=None):
    x = feature_matrix(data, cfg, programs)
    if override is not None and programs:
        x = x.clone()
        x[:, -(len(programs) * cfg.sensors):] = override
    return ridge_predict((x - model["xm"]) / model["xs"], model["w"]) * model["ys"] + model["ym"]


def predict_family(models, data: Dataset, cfg: Config, programs: Sequence[Program], override=None):
    result = torch.empty_like(data.next_obs)
    for family in (0, 1):
        mask = data.world_family.eq(family)
        local_override = override[mask] if override is not None else None
        result[mask] = predict(models[family], subset(data, mask), cfg, programs, local_override)
    return result


def grouped_mse(pred: torch.Tensor, target: torch.Tensor, families: torch.Tensor):
    return {
        str(f): float(F.mse_loss(pred[families == f], target[families == f]))
        for f in (0, 1)
    }


def obs_lags(program: Program) -> set[int]:
    found: set[int] = set()
    if program.op == "obs":
        found.add(int(program.args[0]))
    for arg in program.args:
        if isinstance(arg, Program):
            found.update(obs_lags(arg))
    return found


def score_program(program: Program, train: Dataset, dev: Dataset, cfg: Config, existing):
    if program.size() < 3 or program.op in ("obs", "act", "const") or len(obs_lags(program)) < 2:
        return -1e9, {"0": 1e9, "1": 1e9}
    base_models = fit_family_predictors(train, cfg, existing)
    base_pred = predict_family(base_models, dev, cfg, existing)
    base_family = grouped_mse(base_pred, dev.next_obs, dev.world_family)
    programs = [*existing, program]
    models = fit_family_predictors(train, cfg, programs)
    pred = predict_family(models, dev, cfg, programs)
    by_family = grouped_mse(pred, dev.next_obs, dev.world_family)
    ratios = [by_family[k] / max(base_family[k], 1e-9) for k in ("0", "1")]
    complexity = 0.0002 * program.size()
    return -(max(ratios) + 0.2 * sum(ratios) / len(ratios) + complexity), by_family


def evolve(cfg: Config, train: Dataset, dev: Dataset, seed: int):
    rng = random.Random(seed)
    admitted: list[Program] = []
    genealogy = []
    for slot in range(cfg.admitted):
        population = [random_program(rng, cfg) for _ in range(cfg.population)]
        seen = set()
        best_record = None
        for generation in range(cfg.generations):
            scored = []
            for program in population:
                key = program.digest()
                if key in seen:
                    continue
                seen.add(key)
                score, family = score_program(program, train, dev, cfg, admitted)
                scored.append((score, program, family))
            if not scored:
                population = [random_program(rng, cfg) for _ in range(cfg.population)]
                continue
            scored.sort(key=lambda x: x[0], reverse=True)
            if best_record is None or scored[0][0] > best_record[0]:
                best_record = (scored[0][0], scored[0][1], scored[0][2], generation)
            elites = [x[1] for x in scored[:cfg.elites]]
            next_pop = elites[:]
            while len(next_pop) < cfg.population:
                left = rng.choice(elites)
                child = mutate(left, rng, cfg)
                if rng.random() < 0.45:
                    child = crossover(child, rng.choice(elites), rng, cfg)
                next_pop.append(child)
            population = next_pop
        if best_record is None:
            raise RuntimeError("evolution produced no admissible program")
        admitted.append(best_record[1])
        genealogy.append(
            {
                "slot": slot,
                "program": best_record[1].json(),
                "digest": best_record[1].digest(),
                "development_score": best_record[0],
                "dev_family_mse": best_record[2],
                "generation": best_record[3],
                "size": best_record[1].size(),
                "depth": best_record[1].depth(),
            }
        )
    return admitted, genealogy


def counterfactual_trial(model, data, cfg, programs, worlds, snapshots, ablate=None):
    device = data.action.device
    n = data.action.numel()
    predictions = []
    actuals = []
    for action in range(cfg.actions):
        candidate = Dataset(
            data.obs_history,
            data.action_history,
            torch.full((n,), action, dtype=torch.long, device=device),
            data.next_obs,
            data.world_family,
            data.world_id,
        )
        override = None
        if ablate == "zero" and programs:
            override = torch.zeros(n, len(programs) * cfg.sensors, device=device)
        elif ablate == "shuffle" and programs:
            raw = torch.cat([eval_program(p, candidate) for p in programs], 1)
            g = torch.Generator(device=device).manual_seed(9917 + action)
            override = raw[torch.randperm(n, generator=g, device=device)]
        predictions.append(predict_family(model, candidate, cfg, programs, override))
        actuals.append(
            torch.stack(
                [
                    worlds[int(data.world_id[i].item())].counterfactual(snapshots[i], action)
                    for i in range(n)
                ]
            ).to(device)
        )
    pred = torch.stack(predictions, 1)
    actual = torch.stack(actuals, 1)
    result = {}
    for family in (0, 1):
        mask = data.world_family.eq(family)
        result[str(family)] = float(F.mse_loss(pred[mask], actual[mask]).cpu())
    return result


def intervention_trial(model, data, cfg, programs, worlds, snapshots, ablate=None, target_seed=271828):
    device = data.action.device
    n = data.action.numel()
    candidate_predictions = []
    for action in range(cfg.actions):
        candidate = Dataset(
            data.obs_history,
            data.action_history,
            torch.full((n,), action, dtype=torch.long, device=device),
            data.next_obs,
            data.world_family,
            data.world_id,
        )
        override = None
        if ablate == "zero" and programs:
            override = torch.zeros(n, len(programs) * cfg.sensors, device=device)
        elif ablate == "shuffle" and programs:
            raw = torch.cat([eval_program(p, candidate) for p in programs], 1)
            g = torch.Generator(device=device).manual_seed(9917)
            override = raw[torch.randperm(n, generator=g, device=device)]
        candidate_predictions.append(predict_family(model, candidate, cfg, programs, override))
    predictions = torch.stack(candidate_predictions, 1)
    rng = random.Random(target_seed)
    target_actions = [rng.randrange(cfg.actions) for _ in range(n)]
    targets = torch.stack(
        [
            worlds[int(data.world_id[i].item())].counterfactual(snapshots[i], action)
            for i, action in enumerate(target_actions)
        ]
    ).to(device)
    predicted_cost = (predictions - targets.unsqueeze(1)).square().mean(-1)
    chosen = predicted_cost.argmin(1)
    realized = torch.stack(
        [
            worlds[int(data.world_id[i].item())].counterfactual(snapshots[i], action)
            for i, action in enumerate(chosen.tolist())
        ]
    ).to(device)
    target_tensor = torch.tensor(target_actions, dtype=torch.long, device=device)
    realized_cost = (realized - targets).square().mean(-1)
    return {
        "target_action_accuracy": float(chosen.eq(target_tensor).float().mean().cpu()),
        "target_observation_mse": float(realized_cost.mean().cpu()),
    }


def collect_sealed_with_snapshots(cfg: Config, seed: int):
    parts = []
    snapshots: list[Any] = []
    worlds: dict[int, RawWorld] = {}
    wid = 0
    rng = random.Random(seed)
    for family in (0, 1):
        for index in range(cfg.sealed_worlds_per_family):
            wseed = seed * 100000 + 9000 + family * 100 + index
            world = make_world(cfg, family, wseed)
            worlds[wid] = world
            oh, ah, ac, no, wf, wi = [], [], [], [], [], []
            for trajectory in range(cfg.trajectories_per_world):
                obs = [world.reset(seed ^ wseed ^ trajectory)]
                actions = []
                for _ in range(cfg.steps_per_trajectory):
                    action = rng.randrange(cfg.actions)
                    snap = world.snapshot()
                    nxt = world.step(action)
                    actions.append(action)
                    obs.append(nxt)
                    if len(obs) >= cfg.history + 1:
                        start = len(obs) - cfg.history - 1
                        oh.append(torch.stack(obs[start:start + cfg.history]))
                        ah.append(torch.tensor(actions[start:start + cfg.history - 1], dtype=torch.long))
                        ac.append(action)
                        no.append(nxt)
                        wf.append(family)
                        wi.append(wid)
                        snapshots.append(snap)
            parts.append(
                Dataset(
                    torch.stack(oh),
                    torch.stack(ah),
                    torch.tensor(ac),
                    torch.stack(no),
                    torch.tensor(wf),
                    torch.tensor(wi),
                )
            )
            wid += 1
    return concat(parts), worlds, snapshots


def evaluate_receipt(cfg, programs, genealogy, train, sealed, worlds, snapshots):
    baseline = fit_family_predictors(train, cfg, [])
    instrument = fit_family_predictors(train, cfg, programs)
    base_pred = predict_family(baseline, sealed, cfg, [])
    inst_pred = predict_family(instrument, sealed, cfg, programs)
    raw_inst = torch.cat([eval_program(p, sealed) for p in programs], 1)
    g = torch.Generator(device=raw_inst.device).manual_seed(77123)
    shuffled = raw_inst[
        torch.randperm(raw_inst.size(0), generator=g, device=raw_inst.device)
    ]
    zeroed = torch.zeros_like(raw_inst)
    shuffle_pred = predict_family(instrument, sealed, cfg, programs, shuffled)
    zero_pred = predict_family(instrument, sealed, cfg, programs, zeroed)
    base_family = grouped_mse(base_pred, sealed.next_obs, sealed.world_family)
    inst_family = grouped_mse(inst_pred, sealed.next_obs, sealed.world_family)
    shuf_family = grouped_mse(shuffle_pred, sealed.next_obs, sealed.world_family)
    zero_family = grouped_mse(zero_pred, sealed.next_obs, sealed.world_family)
    cf_inst = counterfactual_trial(instrument, sealed, cfg, programs, worlds, snapshots)
    cf_zero = counterfactual_trial(instrument, sealed, cfg, programs, worlds, snapshots, "zero")
    cf_shuffle = counterfactual_trial(instrument, sealed, cfg, programs, worlds, snapshots, "shuffle")
    cf_base = counterfactual_trial(baseline, sealed, cfg, [], worlds, snapshots)
    action_inst = intervention_trial(instrument, sealed, cfg, programs, worlds, snapshots)
    action_zero = intervention_trial(instrument, sealed, cfg, programs, worlds, snapshots, "zero")
    action_shuffle = intervention_trial(instrument, sealed, cfg, programs, worlds, snapshots, "shuffle")
    action_base = intervention_trial(baseline, sealed, cfg, [], worlds, snapshots)
    checks = {
        "cross_world_prediction_improves": all(
            inst_family[k] < base_family[k] * 0.97 for k in ("0", "1")
        ),
        "counterfactual_intervention_surface_improves": all(
            cf_inst[k] < cf_base[k] * 0.97 for k in ("0", "1")
        ),
        "shuffle_ablation_is_causal": all(
            shuf_family[k] > inst_family[k] * 1.025
            and cf_shuffle[k] > cf_inst[k] * 1.025
            for k in ("0", "1")
        ),
        "zero_ablation_is_causal": all(
            zero_family[k] > inst_family[k] * 1.025
            and cf_zero[k] > cf_inst[k] * 1.025
            for k in ("0", "1")
        ),
        "programs_are_nontrivial": all(
            p.size() >= 3 and len(obs_lags(p)) >= 2 for p in programs
        ),
    }
    return {
        "programs": [p.json() for p in programs],
        "program_digests": [p.digest() for p in programs],
        "genealogy": genealogy,
        "sealed": {
            "baseline_family_mse": base_family,
            "instrument_family_mse": inst_family,
            "shuffle_ablation_family_mse": shuf_family,
            "zero_ablation_family_mse": zero_family,
            "raw_counterfactual_mse": cf_base,
            "instrument_counterfactual_mse": cf_inst,
            "zero_ablation_counterfactual_mse": cf_zero,
            "shuffle_ablation_counterfactual_mse": cf_shuffle,
            "raw_intervention_diagnostic": action_base,
            "instrument_intervention_diagnostic": action_inst,
            "zero_ablation_intervention_diagnostic": action_zero,
            "shuffle_ablation_intervention_diagnostic": action_shuffle,
        },
        "checks": checks,
        "passed": all(checks.values()),
    }


def world_seed_manifest(cfg: Config, seed: int) -> dict[str, list[int]]:
    train = [
        seed * 100000 + 1000 + family * 100 + index
        for family in (0, 1)
        for index in range(cfg.train_worlds_per_family)
    ]
    dev = [
        seed * 100000 + 2000 + family * 100 + index
        for family in (0, 1)
        for index in range(cfg.dev_worlds_per_family)
    ]
    sealed_root = seed ^ 0x5EA1
    sealed = [
        sealed_root * 100000 + 9000 + family * 100 + index
        for family in (0, 1)
        for index in range(cfg.sealed_worlds_per_family)
    ]
    return {"train": train, "dev": dev, "sealed": sealed}


def run_seed(cfg: Config, seed: int, output: pathlib.Path):
    device = torch.device(cfg.device)
    splits = {name: data.to(device) for name, data in build_splits(cfg, seed).items()}
    programs, genealogy = evolve(cfg, splits["train"], splits["dev"], seed)
    sealed_cpu, worlds, snapshots = collect_sealed_with_snapshots(cfg, seed ^ 0x5EA1)
    sealed = sealed_cpu.to(device)
    result = evaluate_receipt(
        cfg, programs, genealogy, splits["train"], sealed, worlds, snapshots
    )
    manifest = world_seed_manifest(cfg, seed)
    result["world_seed_manifest"] = manifest
    result["sealed_is_disjoint"] = (
        set(manifest["sealed"]).isdisjoint(manifest["train"])
        and set(manifest["sealed"]).isdisjoint(manifest["dev"])
    )
    artifact = output / f"instrument-genesis-seed-{seed}.json"
    artifact.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return {"seed": seed, "artifact": str(artifact), **result}


def aggregate(cfg: Config, runs: Sequence[dict[str, Any]]):
    all_digests = [d for run in runs for d in run["program_digests"]]
    within_seed_unique = all(
        len(run["program_digests"]) == len(set(run["program_digests"]))
        for run in runs
    )
    full_budget = (
        cfg.population >= 80
        and cfg.generations >= 28
        and cfg.trajectories_per_world >= 48
        and cfg.admitted >= 3
    )
    checks = {
        "all_seeds_pass": all(run["passed"] for run in runs),
        "three_independent_seeds": len(runs) >= 3,
        "full_declared_budget": full_budget,
        "within_seed_programs_unique": within_seed_unique,
        "sealed_worlds_never_used_in_evolution": all(
            run.get("sealed_is_disjoint", False) for run in runs
        ),
    }
    return {
        "schema": SCHEMA,
        "config": dataclasses.asdict(cfg),
        "runs": list(runs),
        "checks": checks,
        "cross_seed_unique_program_fraction": len(set(all_digests))
        / max(len(all_digests), 1),
        "passed_architecture_gate": all(checks.values()),
        "full_teacher_entry": "unlocked" if all(checks.values()) else "prohibited",
        "product_status": (
            "bounded executable instrument-genesis research product"
            if all(checks.values())
            else "falsified instrument-genesis architecture"
        ),
        "claim_boundary": (
            "A pass establishes that executable measurements synthesized only from raw history "
            "became causal dependencies for cross-world prediction and intervention in two sealed "
            "dynamical families. It does not establish unrestricted concept invention, language "
            "understanding, constitutional ontogenesis, or general intelligence."
        ),
    }


def profile(name: str, device: str) -> Config:
    if name == "smoke":
        return Config(
            train_worlds_per_family=2,
            dev_worlds_per_family=2,
            sealed_worlds_per_family=2,
            trajectories_per_world=18,
            steps_per_trajectory=14,
            population=60,
            generations=14,
            elites=10,
            max_depth=4,
            admitted=2,
            seeds=(17,),
            device=device,
        )
    if name == "full":
        return Config(device=device)
    raise ValueError(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, action="append")
    args = parser.parse_args()
    cfg = profile(args.profile, args.device)
    if args.seed:
        cfg = dataclasses.replace(cfg, seeds=tuple(args.seed))
    cfg.validate()
    output = pathlib.Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    runs = [run_seed(cfg, seed, output) for seed in cfg.seeds]
    receipt = aggregate(cfg, runs)
    path = output / "instrument-genesis-receipt.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
