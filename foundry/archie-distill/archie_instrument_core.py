#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
from dataclasses import asdict, dataclass
from typing import Any, Iterable

import numpy as np

SCHEMA = "archie-instrument-genesis/v1"
FORBIDDEN_WORDS = ("revers", "commit", "safe", "return", "viab", "target")
UNARY = ("abs", "square", "tanh", "signed_log", "neg")
BINARY = ("add", "sub", "mul", "safe_div", "minimum", "maximum")
ACTIONS = np.asarray(((1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)), dtype=np.float64)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Config:
    history: int = 6
    obs_dim: int = 8
    latent_dim: int = 4
    train_worlds_per_family: int = 2
    validation_worlds_per_family: int = 1
    admission_worlds_per_family: int = 1
    sealed_worlds_per_family: int = 1
    train_contexts: int = 96
    eval_contexts: int = 96
    population: int = 64
    generations: int = 18
    elites: int = 12
    max_depth: int = 4
    max_active: int = 5
    ridge: float = 1e-3
    prediction_gate: float = 0.006
    policy_gate: float = 0.004
    ablation_gate: float = 0.002
    seeds: tuple[int, ...] = (17,)
    profile: str = "smoke"


@dataclass(frozen=True)
class Program:
    op: str
    args: tuple["Program", ...] = ()
    value: str | float | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"op": self.op}
        if self.args:
            out["args"] = [arg.to_json() for arg in self.args]
        if self.value is not None:
            out["value"] = self.value
        return out

    @property
    def program_id(self) -> str:
        return digest(self.to_json())[:16]

    @property
    def complexity(self) -> int:
        return 1 + sum(arg.complexity for arg in self.args)


@dataclass
class Individual:
    program: Program
    parents: tuple[str, ...]
    generation: int
    origin: str
    score: float = -1e30
    validation: dict[str, float] | None = None


@dataclass
class Dataset:
    primitive: dict[str, np.ndarray]
    base: np.ndarray
    target: np.ndarray
    group: np.ndarray
    family: np.ndarray
    action_index: np.ndarray


class RawWorld:
    """Three independently parameterized causal families behind raw sensor mixtures."""

    def __init__(self, family: int, seed: int, cfg: Config) -> None:
        self.family = family
        self.cfg = cfg
        rng = np.random.default_rng(seed)
        q, _ = np.linalg.qr(rng.normal(size=(cfg.obs_dim, cfg.latent_dim)))
        self.render = q
        self.render2 = rng.normal(scale=0.22, size=(cfg.obs_dim, cfg.latent_dim))
        self.control = rng.normal(size=(cfg.latent_dim, 2))
        self.control /= np.linalg.norm(self.control, axis=0, keepdims=True) + 1e-9
        self.coupling = rng.normal(scale=0.18, size=(cfg.latent_dim, cfg.latent_dim))
        self.coupling = np.tril(self.coupling, -1)
        self.bias = rng.normal(scale=0.05, size=cfg.latent_dim)
        self.phase = rng.uniform(-math.pi, math.pi)

    def observe(self, state: np.ndarray) -> np.ndarray:
        linear = self.render @ state
        nonlinear = self.render2 @ (state * state)
        return np.tanh(linear + nonlinear)

    def transition(self, state: np.ndarray, action: np.ndarray) -> np.ndarray:
        drive = self.control @ action
        if self.family == 0:
            gate = 1.0 / (1.0 + np.exp(-4.0 * (state[0] + 0.35 * state[2])))
            sticky = np.asarray((0.38 * gate, -0.16 * gate, 0.21 * gate, 0.0))
            nxt = 0.68 * state + self.coupling @ state + drive + sticky + self.bias
        elif self.family == 1:
            theta = 0.28 + 0.18 * np.tanh(state[1])
            rot = np.eye(self.cfg.latent_dim)
            c, s = math.cos(theta), math.sin(theta)
            rot[:2, :2] = ((c, -s), (s, c))
            damping = 0.72 - 0.18 * np.tanh(abs(state[2]))
            nxt = damping * (rot @ state) + drive + 0.12 * np.sin(state + self.phase) + self.bias
        else:
            friction = 0.45 + 0.35 / (1.0 + np.exp(-5.0 * (abs(state[1]) - 0.45)))
            cross = np.asarray((state[1] * state[2], -state[0] * state[3], state[0] * state[1], 0.0))
            nxt = friction * state + drive + 0.18 * cross + self.bias
        alignment = max(0.0, float(np.dot(state, drive) / ((np.linalg.norm(state) * np.linalg.norm(drive)) + 1e-8)))
        nxt = nxt + 0.55 * alignment * np.tanh(state + 0.25 * drive)
        return np.tanh(nxt)

    def sample_context(self, rng: np.random.Generator, history: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        state = rng.normal(scale=0.55, size=self.cfg.latent_dim)
        observations = [self.observe(state)]
        actions = []
        for _ in range(history - 1):
            action = ACTIONS[rng.integers(0, len(ACTIONS))]
            actions.append(action)
            state = self.transition(state, action)
            observations.append(self.observe(state))
        return np.stack(observations), np.stack(actions), state.copy()

    def consequence(self, state: np.ndarray, action: np.ndarray, previous_action: np.ndarray) -> float:
        before = self.observe(state)
        after = self.transition(state.copy(), action)
        repeated = max(0.0, float(np.dot(action, previous_action)))
        after = np.tanh(after + 0.70 * repeated * (self.control @ action))
        restored = self.transition(after, -action)
        return float(np.mean((self.observe(restored) - before) ** 2))


PRIMITIVE_NAMES = (
    "bias",
    "last_mean",
    "last_std",
    "last_l2",
    "last_maxabs",
    "history_l2_mean",
    "history_l2_std",
    "delta1_l2",
    "delta2_l2",
    "delta_ratio",
    "velocity_alignment",
    "curvature_l2",
    "action_x",
    "action_y",
    "last_action_x",
    "last_action_y",
    "prev_action_x",
    "prev_action_y",
)

BASE_NAMES = ("bias", "last_l2", "history_l2_mean", "delta1_l2", "delta2_l2", "action_x", "action_y")


def primitive_row(history: np.ndarray, past_actions: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    d1 = history[-1] - history[-2]
    d2 = history[-2] - history[-3]
    n1 = float(np.linalg.norm(d1))
    n2 = float(np.linalg.norm(d2))
    alignment = float(np.dot(d1, d2) / ((n1 * n2) + 1e-8))
    curvature = float(np.linalg.norm(d1 - d2))
    last_action = past_actions[-1]
    prev_action = past_actions[-2]
    return {
        "bias": 1.0,
        "last_mean": float(history[-1].mean()),
        "last_std": float(history[-1].std()),
        "last_l2": float(np.linalg.norm(history[-1])),
        "last_maxabs": float(np.max(np.abs(history[-1]))),
        "history_l2_mean": float(np.linalg.norm(history, axis=1).mean()),
        "history_l2_std": float(np.linalg.norm(history, axis=1).std()),
        "delta1_l2": n1,
        "delta2_l2": n2,
        "delta_ratio": n1 / (n2 + 1e-6),
        "velocity_alignment": alignment,
        "curvature_l2": curvature,
        "action_x": float(candidate[0]),
        "action_y": float(candidate[1]),
        "last_action_x": float(last_action[0]),
        "last_action_y": float(last_action[1]),
        "prev_action_x": float(prev_action[0]),
        "prev_action_y": float(prev_action[1]),
    }


def make_dataset(cfg: Config, worlds: list[RawWorld], contexts: int, seed: int) -> Dataset:
    rows: list[dict[str, float]] = []
    target: list[float] = []
    group: list[int] = []
    family: list[int] = []
    action_index: list[int] = []
    group_id = 0
    for world_index, world in enumerate(worlds):
        rng = np.random.default_rng(seed + world_index * 1009)
        for _ in range(contexts):
            history, past_actions, state = world.sample_context(rng, cfg.history)
            for index, action in enumerate(ACTIONS):
                rows.append(primitive_row(history, past_actions, action))
                target.append(world.consequence(state, action, past_actions[-1]))
                group.append(group_id)
                family.append(world.family)
                action_index.append(index)
            group_id += 1
    primitive = {name: np.asarray([row[name] for row in rows], dtype=np.float64) for name in PRIMITIVE_NAMES}
    base = np.stack([primitive[name] for name in BASE_NAMES], axis=1)
    return Dataset(
        primitive=primitive,
        base=base,
        target=np.asarray(target, dtype=np.float64),
        group=np.asarray(group, dtype=np.int64),
        family=np.asarray(family, dtype=np.int64),
        action_index=np.asarray(action_index, dtype=np.int64),
    )


def evaluate_program(program: Program, primitive: dict[str, np.ndarray]) -> np.ndarray:
    if program.op == "leaf":
        return primitive[str(program.value)]
    if program.op == "const":
        any_value = next(iter(primitive.values()))
        return np.full_like(any_value, float(program.value))
    if program.op in UNARY:
        x = evaluate_program(program.args[0], primitive)
        if program.op == "abs":
            out = np.abs(x)
        elif program.op == "square":
            out = np.clip(x, -20, 20) ** 2
        elif program.op == "tanh":
            out = np.tanh(x)
        elif program.op == "signed_log":
            out = np.sign(x) * np.log1p(np.abs(x))
        else:
            out = -x
    elif program.op in BINARY:
        a = evaluate_program(program.args[0], primitive)
        b = evaluate_program(program.args[1], primitive)
        if program.op == "add":
            out = a + b
        elif program.op == "sub":
            out = a - b
        elif program.op == "mul":
            out = np.clip(a, -20, 20) * np.clip(b, -20, 20)
        elif program.op == "safe_div":
            out = a / (np.abs(b) + 0.1)
        elif program.op == "minimum":
            out = np.minimum(a, b)
        else:
            out = np.maximum(a, b)
    else:
        raise ValueError(program.op)
    return np.nan_to_num(out, nan=0.0, posinf=50.0, neginf=-50.0).clip(-50, 50)


def random_program(rng: random.Random, depth: int) -> Program:
    if depth <= 0 or rng.random() < 0.32:
        if rng.random() < 0.88:
            return Program("leaf", value=rng.choice(PRIMITIVE_NAMES))
        return Program("const", value=round(rng.uniform(-2.0, 2.0), 3))
    if rng.random() < 0.42:
        return Program(rng.choice(UNARY), (random_program(rng, depth - 1),))
    return Program(rng.choice(BINARY), (random_program(rng, depth - 1), random_program(rng, depth - 1)))


def seed_programs() -> list[Program]:
    raw = [Program("leaf", value=name) for name in PRIMITIVE_NAMES]
    action = ["action_x", "action_y"]
    history_action = ["last_action_x", "last_action_y", "prev_action_x", "prev_action_y"]
    products = [
        Program("mul", (Program("leaf", value=left), Program("leaf", value=right)))
        for left in action for right in history_action
    ]
    sensor_products = [
        Program("mul", (Program("leaf", value=left), Program("leaf", value=right)))
        for left in ("last_mean", "last_std", "delta1_l2", "velocity_alignment")
        for right in action
    ]
    return raw + products + sensor_products


def mutate(program: Program, rng: random.Random, max_depth: int) -> Program:
    roll = rng.random()
    if roll < 0.18:
        return random_program(rng, max_depth)
    if roll < 0.48:
        return Program(rng.choice(UNARY), (program,))
    if roll < 0.78:
        other = random_program(rng, max_depth - 1)
        return Program(rng.choice(BINARY), (program, other) if rng.random() < 0.5 else (other, program))
    if program.args:
        args = list(program.args)
        index = rng.randrange(len(args))
        args[index] = mutate(args[index], rng, max_depth - 1)
        return Program(program.op, tuple(args), program.value)
    return random_program(rng, max_depth)


def compose(a: Program, b: Program, rng: random.Random) -> Program:
    return Program(rng.choice(BINARY), (a, b))


def contains_program(container: Program, needle: Program) -> bool:
    if container == needle:
        return True
    return any(contains_program(arg, needle) for arg in container.args)


def descend(program: Program, rng: random.Random, max_depth: int) -> Program:
    """Create a genuine descendant whose executable AST contains the parent."""
    if rng.random() < 0.38:
        return Program(rng.choice(UNARY), (program,))
    other = random_program(rng, max(1, max_depth - 2))
    return Program(rng.choice(BINARY), (program, other) if rng.random() < 0.5 else (other, program))
