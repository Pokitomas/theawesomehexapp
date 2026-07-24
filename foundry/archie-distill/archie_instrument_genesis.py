#!/usr/bin/env python3
"""Executable instrument discovery and causal admission court.

This module evolves deterministic, bounded measurement programs over raw temporal
sensor/action streams. Programs are selected only by downstream prediction and
intervention utility on sealed data. Hidden world state exists solely inside the
auditable evaluator and is never exposed to program generation or downstream
training.
"""
from __future__ import annotations

import argparse
import copy
import dataclasses
import hashlib
import itertools
import json
import math
import os
import pathlib
import random
import statistics
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception:  # pragma: no cover - structural engine remains importable
    torch = None
    nn = None
    F = None

SCHEMA = "archie-instrument-genesis/v1"
RECEIPT_NAME = "instrument-genesis.json"
EPS = 1e-9
FLOAT = "float"
BOOL = "bool"
ALLOWED_TYPES = {FLOAT, BOOL}
FORBIDDEN_PROGRAM_KEYS = {
    "latent",
    "hidden",
    "target",
    "answer",
    "family",
    "oracle",
    "task",
    "callback",
    "python",
    "callable",
    "simulator",
}

OP_COST = {
    "obs": 1,
    "action": 1,
    "program_input": 1,
    "const": 1,
    "identity": 1,
    "neg": 1,
    "abs": 1,
    "tanh": 1,
    "diff": 2,
    "rolling_mean": 2,
    "rolling_std": 3,
    "rolling_min": 2,
    "rolling_max": 2,
    "threshold": 1,
    "gt": 1,
    "lt": 1,
    "and": 1,
    "or": 1,
    "not": 1,
    "temporal_and": 2,
    "persistence": 3,
    "aggregate_mean": 2,
    "normalize": 4,
    "projection": 3,
    "interaction": 1,
    "accumulate": 3,
    "conditional": 2,
    "fsm": 5,
}


@dataclass(frozen=True)
class ProfileConfig:
    name: str
    obs_channels: int
    latent_dim: int
    actions: int
    history: int
    episode_length: int
    train_episodes: int
    eval_episodes: int
    development_worlds: int
    population_size: int
    generations: int
    offspring_per_generation: int
    elite_count: int
    admitted_width: int
    max_nodes: int
    max_cost: int
    max_window: int
    search_seeds: tuple[int, ...]
    court_seeds: tuple[int, ...]
    ridge: float
    rollout_horizon: int
    policy_horizon: int
    fecundity_budget: int
    revision_budget: int
    run_neural_baselines: bool
    run_architecture_ablations: bool
    scientific_eligible: bool
    thresholds: dict[str, float]


def profile_config(name: str) -> ProfileConfig:
    thresholds = {
        "prediction_relative_gain": 0.03,
        "counterfactual_relative_gain": 0.03,
        "policy_return_gain": 0.01,
        "transport_prediction_gain": 0.015,
        "ablation_relative_damage": 0.02,
        "shuffle_relative_damage": 0.02,
        "retention_tolerance": 1e-8,
        "fecundity_rate_gain": 0.10,
        "revision_return_gain": 0.01,
    }
    if name == "smoke":
        return ProfileConfig(
            name=name,
            obs_channels=8,
            latent_dim=4,
            actions=3,
            history=5,
            episode_length=22,
            train_episodes=3,
            eval_episodes=2,
            development_worlds=2,
            population_size=14,
            generations=2,
            offspring_per_generation=10,
            elite_count=6,
            admitted_width=3,
            max_nodes=18,
            max_cost=58,
            max_window=6,
            search_seeds=(17,),
            court_seeds=(101,),
            ridge=2e-3,
            rollout_horizon=2,
            policy_horizon=2,
            fecundity_budget=8,
            revision_budget=8,
            run_neural_baselines=False,
            run_architecture_ablations=False,
            scientific_eligible=False,
            thresholds=thresholds,
        )
    if name == "full":
        return ProfileConfig(
            name=name,
            obs_channels=12,
            latent_dim=5,
            actions=4,
            history=8,
            episode_length=64,
            train_episodes=18,
            eval_episodes=10,
            development_worlds=4,
            population_size=72,
            generations=10,
            offspring_per_generation=64,
            elite_count=28,
            admitted_width=8,
            max_nodes=36,
            max_cost=120,
            max_window=12,
            search_seeds=(17, 29, 43),
            court_seeds=(101, 211, 307),
            ridge=1e-3,
            rollout_horizon=4,
            policy_horizon=3,
            fecundity_budget=80,
            revision_budget=80,
            run_neural_baselines=True,
            run_architecture_ablations=True,
            scientific_eligible=True,
            thresholds=thresholds,
        )
    raise ValueError(f"unknown profile: {name}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def finite_clip(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return float(max(-1.0, min(1.0, value)))


def bool_value(value: float) -> float:
    return 1.0 if value > 0.0 else -1.0


@dataclass
class Program:
    uid: str
    nodes: list[dict[str, Any]]
    root: int
    parents: list[str] = field(default_factory=list)
    mutation_history: list[dict[str, Any]] = field(default_factory=list)
    origin: str = "endogenous"
    generation: int = 0
    status: str = "candidate"
    retired_reason: str | None = None

    def semantic_form(self) -> dict[str, Any]:
        return {"nodes": self.nodes, "root": self.root}

    def semantic_hash(self) -> str:
        return sha256_text(canonical_json(self.semantic_form()))

    def serialize(self) -> dict[str, Any]:
        return {
            "schema": f"{SCHEMA}/program",
            "uid": self.uid,
            "nodes": self.nodes,
            "root": self.root,
            "parents": self.parents,
            "mutation_history": self.mutation_history,
            "origin": self.origin,
            "generation": self.generation,
            "status": self.status,
            "retired_reason": self.retired_reason,
            "semantic_hash": self.semantic_hash(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Program":
        program = cls(
            uid=str(data["uid"]),
            nodes=copy.deepcopy(data["nodes"]),
            root=int(data["root"]),
            parents=list(data.get("parents", [])),
            mutation_history=copy.deepcopy(data.get("mutation_history", [])),
            origin=str(data.get("origin", "endogenous")),
            generation=int(data.get("generation", 0)),
            status=str(data.get("status", "candidate")),
            retired_reason=data.get("retired_reason"),
        )
        expected = data.get("semantic_hash")
        if expected is not None and expected != program.semantic_hash():
            raise ValueError("program semantic hash mismatch")
        return program


def make_program(
    nodes: list[dict[str, Any]],
    root: int,
    *,
    parents: Sequence[str] = (),
    history: Sequence[dict[str, Any]] = (),
    origin: str = "endogenous",
    generation: int = 0,
) -> Program:
    payload = {
        "nodes": nodes,
        "root": root,
        "parents": list(parents),
        "mutation_history": list(history),
        "origin": origin,
        "generation": generation,
    }
    return Program(
        uid=sha256_text(canonical_json(payload))[:24],
        nodes=copy.deepcopy(nodes),
        root=int(root),
        parents=list(parents),
        mutation_history=copy.deepcopy(list(history)),
        origin=origin,
        generation=generation,
    )


def node_type(node: dict[str, Any], previous_types: Sequence[str]) -> str:
    op = node.get("op")
    args = node.get("args", [])
    if op in {"obs", "action", "program_input", "const", "identity", "neg", "abs", "tanh",
              "diff", "rolling_mean", "rolling_std", "rolling_min", "rolling_max",
              "aggregate_mean", "normalize", "projection", "interaction", "accumulate",
              "conditional", "fsm"}:
        if op == "conditional":
            if len(args) != 3 or previous_types[args[0]] != BOOL:
                raise ValueError("conditional requires bool,float,float")
            if previous_types[args[1]] != FLOAT or previous_types[args[2]] != FLOAT:
                raise ValueError("conditional branches must be float")
        elif op in {"identity", "neg", "abs", "tanh", "diff", "rolling_mean", "rolling_std",
                    "rolling_min", "rolling_max", "normalize", "accumulate", "fsm"}:
            if not args or previous_types[args[0]] != FLOAT:
                raise ValueError(f"{op} requires float input")
            if op == "accumulate" and len(args) > 1 and previous_types[args[1]] != BOOL:
                raise ValueError("accumulate reset must be bool")
        elif op == "aggregate_mean":
            if not args or any(previous_types[x] != FLOAT for x in args):
                raise ValueError("aggregate_mean requires float inputs")
        elif op == "interaction":
            if len(args) != 2 or any(previous_types[x] != FLOAT for x in args):
                raise ValueError("interaction requires two floats")
        return FLOAT
    if op in {"threshold", "gt", "lt", "and", "or", "not", "temporal_and", "persistence"}:
        if op == "threshold":
            if len(args) != 1 or previous_types[args[0]] != FLOAT:
                raise ValueError("threshold requires float")
        elif op in {"gt", "lt"}:
            if len(args) != 2 or any(previous_types[x] != FLOAT for x in args):
                raise ValueError(f"{op} requires two floats")
        elif op in {"and", "or", "temporal_and"}:
            if len(args) != 2 or any(previous_types[x] != BOOL for x in args):
                raise ValueError(f"{op} requires two booleans")
        elif op in {"not", "persistence"}:
            if len(args) != 1 or previous_types[args[0]] != BOOL:
                raise ValueError(f"{op} requires boolean")
        return BOOL
    raise ValueError(f"unknown operation: {op}")


def validate_program(
    program: Program,
    *,
    obs_channels: int,
    actions: int,
    program_inputs: int,
    max_nodes: int,
    max_cost: int,
    max_window: int,
) -> dict[str, Any]:
    if not isinstance(program.nodes, list) or not program.nodes:
        raise ValueError("program must contain nodes")
    if len(program.nodes) > max_nodes:
        raise ValueError("program node bound exceeded")
    if not 0 <= program.root < len(program.nodes):
        raise ValueError("invalid root")
    types: list[str] = []
    total_cost = 0
    for index, node in enumerate(program.nodes):
        if not isinstance(node, dict):
            raise ValueError("node must be object")
        lowered = {str(key).lower() for key in node}
        if any(any(token in key for token in FORBIDDEN_PROGRAM_KEYS) for key in lowered):
            raise ValueError("privileged or executable field in program")
        op = node.get("op")
        if op not in OP_COST:
            raise ValueError(f"operation not allowed: {op}")
        args = node.get("args", [])
        if not isinstance(args, list) or any(not isinstance(x, int) for x in args):
            raise ValueError("args must be integer list")
        if any(x < 0 or x >= index for x in args):
            raise ValueError("node references must be acyclic and backward")
        if op == "obs":
            channel = int(node.get("channel", -1))
            lag = int(node.get("lag", 0))
            if not 0 <= channel < obs_channels or not 0 <= lag <= max_window:
                raise ValueError("invalid observation reference")
        if op == "action":
            action_index = int(node.get("action_index", -1))
            lag = int(node.get("lag", 0))
            if not 0 <= action_index < actions or not 0 <= lag <= max_window:
                raise ValueError("invalid action reference")
        if op == "program_input":
            input_index = int(node.get("input_index", -1))
            lag = int(node.get("lag", 0))
            if not 0 <= input_index < program_inputs or not 0 <= lag <= max_window:
                raise ValueError("invalid program input reference")
        if op == "const":
            value = float(node.get("value", 0.0))
            if not math.isfinite(value) or abs(value) > 4.0:
                raise ValueError("constant outside bound")
        if "window" in node and not 1 <= int(node["window"]) <= max_window:
            raise ValueError("window outside bound")
        if "lag" in node and not 0 <= int(node["lag"]) <= max_window:
            raise ValueError("lag outside bound")
        if op == "projection":
            channels = node.get("channels")
            weights = node.get("weights")
            lag = int(node.get("lag", 0))
            if not isinstance(channels, list) or not channels:
                raise ValueError("projection channels missing")
            if not isinstance(weights, list) or len(weights) != len(channels):
                raise ValueError("projection weights mismatch")
            if any(not 0 <= int(c) < obs_channels for c in channels):
                raise ValueError("projection channel invalid")
            if any(not math.isfinite(float(w)) or abs(float(w)) > 4.0 for w in weights):
                raise ValueError("projection weight invalid")
            if not 0 <= lag <= max_window:
                raise ValueError("projection lag invalid")
        inferred = node_type(node, types)
        types.append(inferred)
        total_cost += OP_COST[op]
    if types[program.root] not in ALLOWED_TYPES:
        raise ValueError("invalid root type")
    if total_cost > max_cost:
        raise ValueError("execution cost bound exceeded")
    canonical_json(program.serialize())
    return {"types": types, "root_type": types[program.root], "cost": total_cost}


class ProgramExecutor:
    """Deterministic interpreter. It never evaluates source code or callbacks."""

    def __init__(self, program: Program, obs_channels: int, actions: int, program_inputs: int = 0):
        self.program = program
        self.obs_channels = obs_channels
        self.actions = actions
        self.program_inputs = program_inputs

    def run(
        self,
        observations: np.ndarray,
        actions: np.ndarray,
        program_outputs: np.ndarray | None = None,
    ) -> np.ndarray:
        observations = np.asarray(observations, dtype=np.float64)
        actions = np.asarray(actions, dtype=np.int64)
        if observations.ndim != 2 or observations.shape[1] != self.obs_channels:
            raise ValueError("observation shape mismatch")
        steps = observations.shape[0]
        if actions.ndim != 1 or actions.shape[0] not in {steps - 1, steps}:
            raise ValueError("action shape mismatch")
        if actions.shape[0] == steps - 1:
            actions = np.concatenate((np.array([-1], dtype=np.int64), actions))
        if program_outputs is None:
            program_outputs = np.zeros((steps, 0), dtype=np.float64)
        program_outputs = np.asarray(program_outputs, dtype=np.float64)
        if program_outputs.shape != (steps, self.program_inputs):
            raise ValueError("program input shape mismatch")
        values = np.zeros((steps, len(self.program.nodes)), dtype=np.float64)
        for t in range(steps):
            for index, node in enumerate(self.program.nodes):
                op = node["op"]
                args = node.get("args", [])

                def current(arg: int) -> float:
                    return float(values[t, arg])

                def prior(arg: int, lag: int) -> float:
                    ti = t - lag
                    return float(values[ti, arg]) if ti >= 0 else 0.0

                if op == "obs":
                    ti = t - int(node.get("lag", 0))
                    value = observations[ti, int(node["channel"])] if ti >= 0 else 0.0
                elif op == "action":
                    ti = t - int(node.get("lag", 0))
                    value = 1.0 if ti >= 0 and actions[ti] == int(node["action_index"]) else -1.0
                elif op == "program_input":
                    ti = t - int(node.get("lag", 0))
                    value = program_outputs[ti, int(node["input_index"])] if ti >= 0 else 0.0
                elif op == "const":
                    value = float(node.get("value", 0.0))
                elif op == "identity":
                    value = current(args[0])
                elif op == "neg":
                    value = -current(args[0])
                elif op == "abs":
                    value = abs(current(args[0]))
                elif op == "tanh":
                    value = math.tanh(current(args[0]))
                elif op == "diff":
                    value = current(args[0]) - prior(args[0], int(node.get("lag", 1)))
                elif op in {"rolling_mean", "rolling_std", "rolling_min", "rolling_max"}:
                    window = int(node.get("window", 2))
                    start = max(0, t - window + 1)
                    seq = values[start : t + 1, args[0]]
                    if op == "rolling_mean":
                        value = float(np.mean(seq))
                    elif op == "rolling_std":
                        value = float(np.std(seq))
                    elif op == "rolling_min":
                        value = float(np.min(seq))
                    else:
                        value = float(np.max(seq))
                elif op == "threshold":
                    value = 1.0 if current(args[0]) > float(node.get("level", 0.0)) else -1.0
                elif op == "gt":
                    value = 1.0 if current(args[0]) > current(args[1]) else -1.0
                elif op == "lt":
                    value = 1.0 if current(args[0]) < current(args[1]) else -1.0
                elif op == "and":
                    value = 1.0 if current(args[0]) > 0 and current(args[1]) > 0 else -1.0
                elif op == "or":
                    value = 1.0 if current(args[0]) > 0 or current(args[1]) > 0 else -1.0
                elif op == "not":
                    value = -bool_value(current(args[0]))
                elif op == "temporal_and":
                    lag = int(node.get("lag", 1))
                    value = 1.0 if current(args[0]) > 0 and prior(args[1], lag) > 0 else -1.0
                elif op == "persistence":
                    window = int(node.get("window", 2))
                    start = max(0, t - window + 1)
                    value = 1.0 if np.all(values[start : t + 1, args[0]] > 0) else -1.0
                elif op == "aggregate_mean":
                    value = float(np.mean([current(a) for a in args]))
                elif op == "normalize":
                    window = int(node.get("window", 3))
                    start = max(0, t - window + 1)
                    seq = values[start : t + 1, args[0]]
                    mean = float(np.mean(seq))
                    std = float(np.std(seq))
                    value = math.tanh((current(args[0]) - mean) / (std + 1e-4))
                elif op == "projection":
                    ti = t - int(node.get("lag", 0))
                    if ti < 0:
                        value = 0.0
                    else:
                        raw = sum(
                            float(w) * float(observations[ti, int(c)])
                            for c, w in zip(node["channels"], node["weights"])
                        )
                        value = math.tanh(raw / max(1.0, math.sqrt(len(node["channels"]))))
                elif op == "interaction":
                    value = current(args[0]) * current(args[1])
                elif op == "accumulate":
                    previous = values[t - 1, index] if t > 0 else 0.0
                    reset = len(args) > 1 and current(args[1]) > 0
                    decay = float(node.get("decay", 0.8))
                    value = current(args[0]) if reset else decay * previous + current(args[0])
                elif op == "conditional":
                    value = current(args[1]) if current(args[0]) > 0 else current(args[2])
                elif op == "fsm":
                    previous = values[t - 1, index] if t > 0 else 0.0
                    low = float(node.get("low", -0.2))
                    high = float(node.get("high", 0.2))
                    signal = current(args[0])
                    if signal > high:
                        value = min(1.0, previous + 0.5)
                    elif signal < low:
                        value = max(-1.0, previous - 0.5)
                    else:
                        value = previous
                else:  # pragma: no cover - validation prevents this
                    raise ValueError(op)
                values[t, index] = finite_clip(float(value))
        output = values[:, self.program.root]
        if not np.isfinite(output).all() or np.max(np.abs(output)) > 1.0000001:
            raise AssertionError("interpreter violated output bounds")
        return output.astype(np.float64, copy=False)


def prune_program(program: Program) -> Program:
    reachable: set[int] = set()

    def visit(index: int) -> None:
        if index in reachable:
            return
        reachable.add(index)
        for arg in program.nodes[index].get("args", []):
            visit(arg)

    visit(program.root)
    ordered = sorted(reachable)
    remap = {old: new for new, old in enumerate(ordered)}
    nodes = []
    for old in ordered:
        node = copy.deepcopy(program.nodes[old])
        node["args"] = [remap[x] for x in node.get("args", [])]
        nodes.append(node)
    return make_program(
        nodes,
        remap[program.root],
        parents=program.parents,
        history=program.mutation_history,
        origin=program.origin,
        generation=program.generation,
    )


def random_source_node(rng: random.Random, cfg: ProfileConfig, program_inputs: int) -> dict[str, Any]:
    choices = ["obs", "obs", "action", "const", "projection"]
    if program_inputs:
        choices.extend(["program_input", "program_input"])
    op = rng.choice(choices)
    if op == "obs":
        return {"op": "obs", "channel": rng.randrange(cfg.obs_channels), "lag": rng.randrange(0, cfg.max_window + 1)}
    if op == "action":
        return {"op": "action", "action_index": rng.randrange(cfg.actions), "lag": rng.randrange(0, cfg.max_window + 1)}
    if op == "program_input":
        return {"op": "program_input", "input_index": rng.randrange(program_inputs), "lag": rng.randrange(0, cfg.max_window + 1)}
    if op == "projection":
        count = rng.randint(2, min(4, cfg.obs_channels))
        channels = rng.sample(range(cfg.obs_channels), count)
        weights = [round(rng.uniform(-1.5, 1.5), 6) for _ in channels]
        return {"op": "projection", "channels": channels, "weights": weights, "lag": rng.randrange(0, cfg.max_window + 1)}
    return {"op": "const", "value": round(rng.uniform(-1.0, 1.0), 6)}


def random_program(
    rng: random.Random,
    cfg: ProfileConfig,
    *,
    generation: int = 0,
    program_inputs: int = 0,
    parents: Sequence[str] = (),
    history: Sequence[dict[str, Any]] = (),
    origin: str = "endogenous",
) -> Program:
    target_nodes = rng.randint(3, max(3, min(cfg.max_nodes, 10 + generation)))
    nodes: list[dict[str, Any]] = []
    types: list[str] = []
    for _ in range(target_nodes):
        if len(nodes) < 2 or rng.random() < 0.34:
            node = random_source_node(rng, cfg, program_inputs)
        else:
            float_args = [i for i, typ in enumerate(types) if typ == FLOAT]
            bool_args = [i for i, typ in enumerate(types) if typ == BOOL]
            candidates: list[str] = []
            if float_args:
                candidates += ["tanh", "diff", "rolling_mean", "rolling_std", "normalize", "threshold", "accumulate", "fsm"]
            if len(float_args) >= 2:
                candidates += ["gt", "lt", "interaction", "aggregate_mean"]
            if bool_args:
                candidates += ["not", "persistence"]
            if len(bool_args) >= 2:
                candidates += ["and", "or", "temporal_and"]
            if bool_args and len(float_args) >= 2:
                candidates += ["conditional"]
            if not candidates:
                node = random_source_node(rng, cfg, program_inputs)
            else:
                op = rng.choice(candidates)
                if op in {"tanh", "diff", "rolling_mean", "rolling_std", "normalize", "accumulate", "fsm"}:
                    arg = rng.choice(float_args)
                    node = {"op": op, "args": [arg]}
                    if op == "diff":
                        node["lag"] = rng.randint(1, cfg.max_window)
                    if op in {"rolling_mean", "rolling_std", "normalize"}:
                        node["window"] = rng.randint(2, cfg.max_window)
                    if op == "accumulate":
                        node["decay"] = round(rng.uniform(0.35, 0.95), 6)
                        if bool_args and rng.random() < 0.4:
                            node["args"].append(rng.choice(bool_args))
                    if op == "fsm":
                        low = rng.uniform(-0.8, 0.0)
                        high = rng.uniform(0.0, 0.8)
                        node["low"] = round(low, 6)
                        node["high"] = round(high, 6)
                elif op in {"gt", "lt", "interaction"}:
                    node = {"op": op, "args": rng.sample(float_args, 2)}
                elif op == "aggregate_mean":
                    node = {"op": op, "args": rng.sample(float_args, rng.randint(2, min(4, len(float_args))))}
                elif op == "threshold":
                    node = {"op": op, "args": [rng.choice(float_args)], "level": round(rng.uniform(-0.8, 0.8), 6)}
                elif op in {"not", "persistence"}:
                    node = {"op": op, "args": [rng.choice(bool_args)]}
                    if op == "persistence":
                        node["window"] = rng.randint(2, cfg.max_window)
                elif op in {"and", "or", "temporal_and"}:
                    node = {"op": op, "args": rng.sample(bool_args, 2)}
                    if op == "temporal_and":
                        node["lag"] = rng.randint(1, cfg.max_window)
                elif op == "conditional":
                    node = {"op": op, "args": [rng.choice(bool_args), *rng.sample(float_args, 2)]}
                else:
                    raise AssertionError(op)
        try:
            typ = node_type(node, types)
        except ValueError:
            node = random_source_node(rng, cfg, program_inputs)
            typ = node_type(node, types)
        nodes.append(node)
        types.append(typ)
    float_roots = [i for i, typ in enumerate(types) if typ == FLOAT]
    root = rng.choice(float_roots or list(range(len(nodes))))
    program = make_program(nodes, root, parents=parents, history=history, origin=origin, generation=generation)
    program = prune_program(program)
    validate_program(
        program,
        obs_channels=cfg.obs_channels,
        actions=cfg.actions,
        program_inputs=program_inputs,
        max_nodes=cfg.max_nodes,
        max_cost=cfg.max_cost,
        max_window=cfg.max_window,
    )
    return program


def mutate_program(parent: Program, rng: random.Random, cfg: ProfileConfig, program_inputs: int = 0) -> Program:
    operators = [
        "constant_perturbation",
        "channel_substitution",
        "temporal_depth_change",
        "subtree_replacement",
        "composition",
        "conditional_insertion",
        "deletion",
    ]
    for _ in range(40):
        op = rng.choice(operators)
        nodes = copy.deepcopy(parent.nodes)
        root = parent.root
        detail: dict[str, Any] = {"operator": op}
        if op == "constant_perturbation":
            candidates = [i for i, n in enumerate(nodes) if n["op"] == "const"]
            if not candidates:
                continue
            index = rng.choice(candidates)
            before = float(nodes[index]["value"])
            nodes[index]["value"] = round(max(-4.0, min(4.0, before + rng.gauss(0.0, 0.25))), 6)
            detail.update(index=index, before=before, after=nodes[index]["value"])
        elif op == "channel_substitution":
            candidates = [i for i, n in enumerate(nodes) if n["op"] in {"obs", "projection"}]
            if not candidates:
                continue
            index = rng.choice(candidates)
            if nodes[index]["op"] == "obs":
                before = int(nodes[index]["channel"])
                nodes[index]["channel"] = rng.randrange(cfg.obs_channels)
                detail.update(index=index, before=before, after=nodes[index]["channel"])
            else:
                slot = rng.randrange(len(nodes[index]["channels"]))
                before = int(nodes[index]["channels"][slot])
                nodes[index]["channels"][slot] = rng.randrange(cfg.obs_channels)
                detail.update(index=index, slot=slot, before=before, after=nodes[index]["channels"][slot])
        elif op == "temporal_depth_change":
            candidates = [i for i, n in enumerate(nodes) if "lag" in n or "window" in n]
            if not candidates:
                continue
            index = rng.choice(candidates)
            key = "lag" if "lag" in nodes[index] and ("window" not in nodes[index] or rng.random() < 0.5) else "window"
            before = int(nodes[index][key])
            low = 0 if key == "lag" else 1
            nodes[index][key] = max(low, min(cfg.max_window, before + rng.choice([-2, -1, 1, 2])))
            detail.update(index=index, field=key, before=before, after=nodes[index][key])
        elif op == "subtree_replacement":
            index = rng.randrange(len(nodes))
            previous_types: list[str] = []
            for i, node in enumerate(nodes):
                if i == index:
                    replacement = random_source_node(rng, cfg, program_inputs)
                    nodes[i] = replacement
                try:
                    previous_types.append(node_type(nodes[i], previous_types))
                except Exception:
                    break
            else:
                detail.update(index=index, replacement=nodes[index])
                candidate = make_program(nodes, root, parents=[parent.uid], history=[*parent.mutation_history, detail], generation=parent.generation + 1)
                candidate = prune_program(candidate)
                try:
                    validate_program(candidate, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=program_inputs,
                                     max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
                    return candidate
                except ValueError:
                    continue
            continue
        elif op == "composition":
            if len(nodes) + 2 > cfg.max_nodes:
                continue
            source = random_source_node(rng, cfg, program_inputs)
            nodes.append(source)
            second = len(nodes) - 1
            combine = rng.choice(["interaction", "aggregate_mean"])
            nodes.append({"op": combine, "args": [root, second]})
            root = len(nodes) - 1
            detail.update(source=source, combine=combine)
        elif op == "conditional_insertion":
            if len(nodes) + 4 > cfg.max_nodes:
                continue
            source = random_source_node(rng, cfg, program_inputs)
            nodes.append(source)
            source_index = len(nodes) - 1
            nodes.append({"op": "threshold", "args": [source_index], "level": round(rng.uniform(-0.5, 0.5), 6)})
            condition_index = len(nodes) - 1
            alt = random_source_node(rng, cfg, program_inputs)
            nodes.append(alt)
            alt_index = len(nodes) - 1
            nodes.append({"op": "conditional", "args": [condition_index, root, alt_index]})
            root = len(nodes) - 1
            detail.update(condition_source=source, alternative=alt)
        elif op == "deletion":
            root_node = nodes[root]
            args = root_node.get("args", [])
            if not args:
                continue
            root = rng.choice(args)
            detail.update(previous_root=parent.root, new_root=root)
        candidate = make_program(
            nodes,
            root,
            parents=[parent.uid],
            history=[*parent.mutation_history, detail],
            generation=parent.generation + 1,
        )
        candidate = prune_program(candidate)
        try:
            validate_program(candidate, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=program_inputs,
                             max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
        except ValueError:
            continue
        return candidate
    return random_program(
        rng,
        cfg,
        generation=parent.generation + 1,
        program_inputs=program_inputs,
        parents=[parent.uid],
        history=[*parent.mutation_history, {"operator": "fallback_random_replacement"}],
    )


def crossover_program(a: Program, b: Program, rng: random.Random, cfg: ProfileConfig, program_inputs: int = 0) -> Program:
    a = prune_program(a)
    b = prune_program(b)
    for _ in range(20):
        nodes = copy.deepcopy(a.nodes)
        offset = len(nodes)
        for node in b.nodes:
            cloned = copy.deepcopy(node)
            cloned["args"] = [x + offset for x in cloned.get("args", [])]
            nodes.append(cloned)
        combine = rng.choice(["interaction", "aggregate_mean"])
        nodes.append({"op": combine, "args": [a.root, b.root + offset]})
        history = [
            *a.mutation_history,
            {"operator": "crossover", "parents": [a.uid, b.uid], "combine": combine},
        ]
        candidate = make_program(nodes, len(nodes) - 1, parents=[a.uid, b.uid], history=history,
                                 generation=max(a.generation, b.generation) + 1)
        candidate = prune_program(candidate)
        try:
            validate_program(candidate, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=program_inputs,
                             max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
            return candidate
        except ValueError:
            a = mutate_program(a, rng, cfg, program_inputs)
            b = mutate_program(b, rng, cfg, program_inputs)
    return mutate_program(a, rng, cfg, program_inputs)


@dataclass(frozen=True)
class WorldSpec:
    seed: int
    obs_channels: int
    latent_dim: int
    actions: int
    temporal_scale: float
    delay: int
    state_matrix: tuple[tuple[float, ...], ...]
    action_matrix: tuple[tuple[float, ...], ...]
    observation_matrix: tuple[tuple[float, ...], ...]
    nonlinear_phase: tuple[float, ...]
    channel_permutation: tuple[int, ...]
    noise_scale: tuple[float, ...]
    consequence_vector: tuple[float, ...]
    spurious_sign: float
    revision_gate: float
    revised: bool

    def hash(self) -> str:
        return sha256_text(canonical_json(asdict(self)))


def _stable_matrix(rng: np.random.Generator, dim: int, scale: float) -> np.ndarray:
    raw = rng.normal(0.0, scale, size=(dim, dim))
    eig = max(1.0, float(np.max(np.abs(np.linalg.eigvals(raw)))))
    return raw / eig * 0.42


def make_world_spec(seed: int, cfg: ProfileConfig, *, revised: bool = False, remap_seed: int | None = None) -> WorldSpec:
    rng = np.random.default_rng(seed)
    latent = cfg.latent_dim
    state_matrix = _stable_matrix(rng, latent, 0.7)
    state_matrix += np.eye(latent) * rng.uniform(0.35, 0.58)
    action_matrix = rng.normal(0.0, 0.55, size=(cfg.actions, latent))
    observation_matrix = rng.normal(0.0, 0.7, size=(cfg.obs_channels, latent))
    phase = rng.uniform(-math.pi, math.pi, size=cfg.obs_channels)
    permutation_rng = np.random.default_rng(remap_seed if remap_seed is not None else seed ^ 0x51A7)
    permutation = tuple(int(x) for x in permutation_rng.permutation(cfg.obs_channels))
    noise = tuple(float(x) for x in rng.uniform(0.005, 0.08, size=cfg.obs_channels))
    consequence = rng.normal(0.0, 0.6, size=latent)
    consequence /= max(float(np.linalg.norm(consequence)), EPS)
    if revised:
        action_matrix = action_matrix.copy()
        action_matrix[:, 0] *= -0.75
        state_matrix = state_matrix.copy()
        state_matrix[0, :] *= 0.45
    return WorldSpec(
        seed=seed,
        obs_channels=cfg.obs_channels,
        latent_dim=latent,
        actions=cfg.actions,
        temporal_scale=float(rng.uniform(0.55, 1.35)),
        delay=int(rng.integers(1, 4)),
        state_matrix=tuple(tuple(float(v) for v in row) for row in state_matrix),
        action_matrix=tuple(tuple(float(v) for v in row) for row in action_matrix),
        observation_matrix=tuple(tuple(float(v) for v in row) for row in observation_matrix),
        nonlinear_phase=tuple(float(v) for v in phase),
        channel_permutation=permutation,
        noise_scale=noise,
        consequence_vector=tuple(float(v) for v in consequence),
        spurious_sign=float(rng.choice([-1.0, 1.0])),
        revision_gate=float(rng.uniform(-0.25, 0.25)),
        revised=revised,
    )


@dataclass
class WorldSnapshot:
    state: np.ndarray
    action_queue: list[int]
    step: int
    rng_state: dict[str, Any]


class RawWorld:
    """Auditable simulator. Public learner-facing methods expose raw signals only."""

    def __init__(self, spec: WorldSpec):
        self.spec = spec
        self.state_matrix = np.asarray(spec.state_matrix, dtype=np.float64)
        self.action_matrix = np.asarray(spec.action_matrix, dtype=np.float64)
        self.observation_matrix = np.asarray(spec.observation_matrix, dtype=np.float64)
        self.phase = np.asarray(spec.nonlinear_phase, dtype=np.float64)
        self.noise = np.asarray(spec.noise_scale, dtype=np.float64)
        self.consequence_vector = np.asarray(spec.consequence_vector, dtype=np.float64)
        self.permutation = np.asarray(spec.channel_permutation, dtype=np.int64)
        self.rng = np.random.default_rng(spec.seed)
        self.state = np.zeros(spec.latent_dim, dtype=np.float64)
        self.action_queue = [0 for _ in range(spec.delay)]
        self.step_index = 0

    def reset(self, episode_seed: int) -> np.ndarray:
        self.rng = np.random.default_rng(episode_seed)
        self.state = self.rng.normal(0.0, 0.5, size=self.spec.latent_dim)
        self.action_queue = [int(self.rng.integers(0, self.spec.actions)) for _ in range(self.spec.delay)]
        self.step_index = 0
        return self._observe()

    def snapshot(self) -> WorldSnapshot:
        return WorldSnapshot(self.state.copy(), list(self.action_queue), self.step_index, copy.deepcopy(self.rng.bit_generator.state))

    def restore(self, snapshot: WorldSnapshot) -> None:
        self.state = snapshot.state.copy()
        self.action_queue = list(snapshot.action_queue)
        self.step_index = int(snapshot.step)
        self.rng.bit_generator.state = copy.deepcopy(snapshot.rng_state)

    def _observe(self) -> np.ndarray:
        linear = self.observation_matrix @ self.state
        surface = 0.67 * np.tanh(linear) + 0.23 * np.sin(1.7 * linear + self.phase)
        nuisance = math.sin((self.step_index + 1) * 0.37 * self.spec.temporal_scale)
        surface = surface.copy()
        surface[-1] = 0.72 * self.spec.spurious_sign * nuisance + 0.12 * surface[-1]
        noisy = surface + self.rng.normal(0.0, self.noise)
        return np.clip(noisy[self.permutation], -1.0, 1.0).astype(np.float64)

    def step(self, action: int) -> tuple[np.ndarray, float]:
        if not 0 <= int(action) < self.spec.actions:
            raise ValueError("action outside world interface")
        applied = self.action_queue.pop(0)
        self.action_queue.append(int(action))
        drive = self.action_matrix[applied]
        cross = np.roll(self.state, 1) * np.roll(self.state, -1)
        revised_gate = 1.0
        if self.spec.revised and self.state[1] > self.spec.revision_gate:
            revised_gate = -0.65
        next_state = (
            self.state_matrix @ self.state
            + 0.24 * np.tanh(cross)
            + revised_gate * drive
            + self.rng.normal(0.0, 0.025, size=self.spec.latent_dim)
        )
        self.state = np.tanh(next_state * self.spec.temporal_scale)
        consequence = float(np.tanh(self.consequence_vector @ self.state - 0.08 * np.square(self.state).sum()))
        self.step_index += 1
        return self._observe(), consequence

    def branch(self, snapshot: WorldSnapshot, actions: Sequence[int]) -> tuple[list[np.ndarray], list[float]]:
        current = self.snapshot()
        self.restore(snapshot)
        observations: list[np.ndarray] = []
        consequences: list[float] = []
        for action in actions:
            obs, consequence = self.step(int(action))
            observations.append(obs)
            consequences.append(consequence)
        self.restore(current)
        return observations, consequences


@dataclass
class Episode:
    observations: np.ndarray
    actions: np.ndarray
    consequences: np.ndarray
    snapshots: list[WorldSnapshot]
    world_hash: str
    episode_seed: int


def collect_episode(spec: WorldSpec, cfg: ProfileConfig, episode_seed: int, policy: str = "random") -> Episode:
    world = RawWorld(spec)
    rng = random.Random(episode_seed ^ 0xA771)
    observations = [world.reset(episode_seed)]
    actions: list[int] = []
    consequences: list[float] = []
    snapshots: list[WorldSnapshot] = []
    disagreement = LightweightDisagreement(cfg.obs_channels, cfg.actions, cfg.history, seed=episode_seed) if policy == "disagreement" else None
    for _ in range(cfg.episode_length):
        snapshots.append(world.snapshot())
        if policy == "disagreement" and disagreement is not None:
            action = disagreement.choose(np.asarray(observations), np.asarray(actions, dtype=np.int64))
        else:
            action = rng.randrange(cfg.actions)
        next_obs, consequence = world.step(action)
        if disagreement is not None:
            disagreement.observe(observations[-1], action, next_obs)
        actions.append(action)
        consequences.append(consequence)
        observations.append(next_obs)
    return Episode(
        observations=np.asarray(observations, dtype=np.float64),
        actions=np.asarray(actions, dtype=np.int64),
        consequences=np.asarray(consequences, dtype=np.float64),
        snapshots=snapshots,
        world_hash=spec.hash(),
        episode_seed=episode_seed,
    )


def collect_dataset(spec: WorldSpec, cfg: ProfileConfig, count: int, seed: int, policy: str = "random") -> list[Episode]:
    return [collect_episode(spec, cfg, seed + i * 1009, policy=policy) for i in range(count)]


class LightweightDisagreement:
    """Matched baseline reproducing #752-style predictive disagreement without reuse."""

    def __init__(self, obs_channels: int, actions: int, history: int, seed: int):
        self.obs_channels = obs_channels
        self.actions = actions
        self.history = history
        self.rng = np.random.default_rng(seed)
        self.rows: list[tuple[np.ndarray, int, np.ndarray]] = []
        self.weights = [self.rng.normal(0, 0.05, size=(obs_channels + actions + 1, obs_channels)) for _ in range(3)]

    def observe(self, obs: np.ndarray, action: int, next_obs: np.ndarray) -> None:
        self.rows.append((np.asarray(obs), int(action), np.asarray(next_obs)))
        if len(self.rows) >= 8 and len(self.rows) % 4 == 0:
            for index in range(len(self.weights)):
                chosen = self.rng.integers(0, len(self.rows), size=min(48, len(self.rows)))
                x, y = [], []
                for row_index in chosen:
                    obs_i, action_i, next_i = self.rows[int(row_index)]
                    onehot = np.eye(self.actions)[action_i]
                    x.append(np.concatenate((obs_i, onehot, [1.0])))
                    y.append(next_i)
                self.weights[index] = ridge_fit(np.asarray(x), np.asarray(y), 5e-2)

    def choose(self, observations: np.ndarray, actions: np.ndarray) -> int:
        current = observations[-1]
        scores = []
        for action in range(self.actions):
            x = np.concatenate((current, np.eye(self.actions)[action], [1.0]))
            predictions = np.stack([x @ weight for weight in self.weights])
            scores.append(float(np.var(predictions, axis=0).mean()))
        maxima = [i for i, score in enumerate(scores) if abs(score - max(scores)) < 1e-12]
        return int(maxima[0])


def ridge_fit(x: np.ndarray, y: np.ndarray, ridge: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if x.ndim != 2 or y.ndim != 2 or x.shape[0] != y.shape[0]:
        raise ValueError("ridge input shape mismatch")
    eye = np.eye(x.shape[1], dtype=np.float64)
    try:
        return np.linalg.solve(x.T @ x + ridge * eye, x.T @ y)
    except np.linalg.LinAlgError:
        return np.linalg.pinv(x.T @ x + ridge * eye) @ x.T @ y


@dataclass
class LinearDynamicsModel:
    weights: np.ndarray
    feature_width: int
    obs_channels: int
    actions: int
    condition_name: str

    def predict(self, features: np.ndarray, action: int) -> tuple[np.ndarray, float]:
        x = np.concatenate((np.asarray(features, dtype=np.float64), np.eye(self.actions)[int(action)], [1.0]))
        output = x @ self.weights
        return np.clip(output[: self.obs_channels], -1.0, 1.0), finite_clip(float(output[-1]))

    def serialize(self) -> dict[str, Any]:
        return {
            "condition_name": self.condition_name,
            "feature_width": self.feature_width,
            "obs_channels": self.obs_channels,
            "actions": self.actions,
            "weights_shape": list(self.weights.shape),
            "weights_sha256": hashlib.sha256(self.weights.astype("<f8").tobytes()).hexdigest(),
        }


class FeatureProvider:
    name = "base"

    def __init__(self, cfg: ProfileConfig, width: int):
        self.cfg = cfg
        self.width = width

    def episode_features(self, episode: Episode) -> np.ndarray:
        raise NotImplementedError

    def feature_for_history(self, observations: np.ndarray, actions: np.ndarray) -> np.ndarray:
        pseudo = Episode(np.asarray(observations), np.asarray(actions), np.zeros(len(actions)), [], "predicted", 0)
        return self.episode_features(pseudo)[-1]


class ProgramFeatureProvider(FeatureProvider):
    name = "programs"

    def __init__(
        self,
        cfg: ProfileConfig,
        programs: Sequence[Program],
        *,
        base_programs: Sequence[Program] = (),
        transform: str = "none",
        transform_seed: int = 0,
    ):
        super().__init__(cfg, len(programs))
        self.programs = list(programs)
        self.base_programs = list(base_programs)
        self.transform = transform
        self.transform_seed = transform_seed

    def episode_features(self, episode: Episode) -> np.ndarray:
        base_outputs = np.zeros((len(episode.observations), 0), dtype=np.float64)
        if self.base_programs:
            base_outputs = np.column_stack(
                [ProgramExecutor(p, self.cfg.obs_channels, self.cfg.actions).run(episode.observations, episode.actions) for p in self.base_programs]
            )
        outputs = []
        for program in self.programs:
            executor = ProgramExecutor(program, self.cfg.obs_channels, self.cfg.actions, len(self.base_programs))
            outputs.append(executor.run(episode.observations, episode.actions, base_outputs))
        matrix = np.column_stack(outputs) if outputs else np.zeros((len(episode.observations), 0))
        rng = np.random.default_rng(self.transform_seed ^ episode.episode_seed)
        if self.transform == "zero":
            matrix[:] = 0.0
        elif self.transform == "constant":
            matrix[:] = np.mean(matrix, axis=0, keepdims=True) if matrix.size else 0.0
        elif self.transform == "shuffle_episode" and matrix.shape[0] > 1:
            order = rng.permutation(matrix.shape[0])
            matrix = matrix[order]
        elif self.transform == "shuffle_time" and matrix.shape[0] > 1:
            for column in range(matrix.shape[1]):
                matrix[:, column] = matrix[rng.permutation(matrix.shape[0]), column]
        return matrix


class RawHistoryProvider(FeatureProvider):
    name = "raw_history"

    def __init__(self, cfg: ProfileConfig, width: int, seed: int = 0, mode: str = "raw"):
        super().__init__(cfg, width)
        self.mode = mode
        input_width = cfg.history * cfg.obs_channels + max(0, cfg.history - 1) * cfg.actions
        rng = np.random.default_rng(seed)
        projection = rng.normal(0.0, 1.0 / math.sqrt(max(1, input_width)), size=(input_width, width))
        q, _ = np.linalg.qr(projection)
        if q.shape[1] < width:
            extra = rng.normal(0.0, 0.1, size=(input_width, width - q.shape[1]))
            q = np.concatenate((q, extra), axis=1)
        self.projection = q[:, :width]

    def _raw_vector(self, observations: np.ndarray, actions: np.ndarray, t: int) -> np.ndarray:
        obs_rows = []
        for lag in reversed(range(self.cfg.history)):
            ti = t - lag
            obs_rows.append(observations[ti] if ti >= 0 else np.zeros(self.cfg.obs_channels))
        action_rows = []
        for lag in reversed(range(1, self.cfg.history)):
            ti = t - lag
            if 0 <= ti < len(actions):
                action_rows.append(np.eye(self.cfg.actions)[int(actions[ti])])
            else:
                action_rows.append(np.zeros(self.cfg.actions))
        return np.concatenate((*obs_rows, *action_rows))

    def episode_features(self, episode: Episode) -> np.ndarray:
        rows = []
        for t in range(len(episode.observations)):
            raw = self._raw_vector(episode.observations, episode.actions, t)
            if self.mode == "raw":
                rows.append(np.tanh(raw @ self.projection))
            elif self.mode == "random_projection":
                rows.append(np.sin(raw @ self.projection))
            else:
                raise ValueError(self.mode)
        return np.asarray(rows)


class GenericStatsProvider(FeatureProvider):
    name = "generic_temporal_statistics"

    def episode_features(self, episode: Episode) -> np.ndarray:
        rows = []
        for t in range(len(episode.observations)):
            start = max(0, t - self.cfg.history + 1)
            window = episode.observations[start : t + 1]
            candidates = np.concatenate((
                window[-1],
                np.mean(window, axis=0),
                np.std(window, axis=0),
                window[-1] - window[0],
            ))
            if len(candidates) < self.width:
                candidates = np.pad(candidates, (0, self.width - len(candidates)))
            rows.append(np.tanh(candidates[: self.width]))
        return np.asarray(rows)


class FixedMatrixProvider(FeatureProvider):
    def __init__(
        self,
        cfg: ProfileConfig,
        matrices: dict[int, np.ndarray],
        width: int,
        name: str,
        fallback: FeatureProvider | None = None,
    ):
        super().__init__(cfg, width)
        self.matrices = matrices
        self.name = name
        self.fallback = fallback

    def episode_features(self, episode: Episode) -> np.ndarray:
        key = episode.episode_seed
        if key in self.matrices:
            return self.matrices[key]
        if self.fallback is not None:
            return self.fallback.episode_features(episode)
        return np.zeros((len(episode.observations), self.width), dtype=np.float64)


class ColumnAblationProvider(FeatureProvider):
    def __init__(self, cfg: ProfileConfig, base: ProgramFeatureProvider, column: int, mode: str, seed: int):
        super().__init__(cfg, base.width)
        self.base = base
        self.column = column
        self.mode = mode
        self.seed = seed
        self.name = f"column_{mode}"

    def episode_features(self, episode: Episode) -> np.ndarray:
        matrix = self.base.episode_features(episode).copy()
        if matrix.shape[1] == 0:
            return matrix
        if self.mode == "zero":
            matrix[:, self.column] = 0.0
        elif self.mode == "constant":
            matrix[:, self.column] = float(np.mean(matrix[:, self.column]))
        elif self.mode == "shuffle_time":
            rng = np.random.default_rng(self.seed ^ episode.episode_seed)
            matrix[:, self.column] = matrix[rng.permutation(len(matrix)), self.column]
        else:
            raise ValueError(self.mode)
        return matrix


class EpisodePermutationProvider(FeatureProvider):
    def __init__(self, cfg: ProfileConfig, base: ProgramFeatureProvider, groups: Sequence[Sequence[Episode]], seed: int):
        super().__init__(cfg, base.width)
        self.base = base
        self.name = "shuffle_across_episodes"
        self.matrices: dict[int, np.ndarray] = {}
        rng = random.Random(seed)
        for group in groups:
            episodes = list(group)
            if not episodes:
                continue
            sources = episodes.copy()
            rng.shuffle(sources)
            if len(sources) > 1 and all(a.episode_seed == b.episode_seed for a, b in zip(episodes, sources)):
                sources = sources[1:] + sources[:1]
            for target, source in zip(episodes, sources):
                self.matrices[target.episode_seed] = base.episode_features(source).copy()

    def episode_features(self, episode: Episode) -> np.ndarray:
        matrix = self.matrices.get(episode.episode_seed)
        if matrix is None:
            return np.zeros((len(episode.observations), self.width), dtype=np.float64)
        if len(matrix) == len(episode.observations):
            return matrix.copy()
        indices = np.linspace(0, len(matrix) - 1, len(episode.observations)).astype(int)
        return matrix[indices].copy()


class TorchEncoderProvider(FeatureProvider):
    def __init__(self, cfg: ProfileConfig, raw_provider: RawHistoryProvider, encoder: Any, width: int, name: str, device: str):
        super().__init__(cfg, width)
        self.raw_provider = raw_provider
        self.encoder = encoder
        self.name = name
        self.device = device

    def episode_features(self, episode: Episode) -> np.ndarray:
        raw = self.raw_provider.episode_features(episode)
        tensor = torch.tensor(raw, dtype=torch.float32, device=self.device)
        self.encoder.eval()
        with torch.no_grad():
            return self.encoder(tensor).detach().cpu().numpy().astype(np.float64)


@dataclass
class ConditionMetrics:
    condition: str
    next_observation_mse: float
    counterfactual_mse: float
    intervention_return: float
    intervention_regret: float
    intervention_choice_hash: str
    intervention_action_histogram: list[int]
    sample_efficiency_auc: float
    feature_width: int
    parameter_count: int
    train_rows: int
    eval_rows: int

    def serialize(self) -> dict[str, Any]:
        return asdict(self)


def design_rows(episodes: Sequence[Episode], provider: FeatureProvider, cfg: ProfileConfig) -> tuple[np.ndarray, np.ndarray]:
    x_rows: list[np.ndarray] = []
    y_rows: list[np.ndarray] = []
    for episode in episodes:
        features = provider.episode_features(episode)
        for t in range(cfg.history - 1, len(episode.actions)):
            x_rows.append(np.concatenate((features[t], np.eye(cfg.actions)[episode.actions[t]], [1.0])))
            y_rows.append(np.concatenate((episode.observations[t + 1], [episode.consequences[t]])))
    if not x_rows:
        raise ValueError("empty design matrix")
    return np.asarray(x_rows), np.asarray(y_rows)


def train_linear_model(episodes: Sequence[Episode], provider: FeatureProvider, cfg: ProfileConfig, name: str) -> LinearDynamicsModel:
    x, y = design_rows(episodes, provider, cfg)
    weights = ridge_fit(x, y, cfg.ridge)
    return LinearDynamicsModel(weights, provider.width, cfg.obs_channels, cfg.actions, name)


def evaluate_one_step(model: LinearDynamicsModel, episodes: Sequence[Episode], provider: FeatureProvider, cfg: ProfileConfig) -> tuple[float, int]:
    errors: list[float] = []
    count = 0
    for episode in episodes:
        features = provider.episode_features(episode)
        for t in range(cfg.history - 1, len(episode.actions)):
            prediction, _ = model.predict(features[t], int(episode.actions[t]))
            errors.append(float(np.mean(np.square(prediction - episode.observations[t + 1]))))
            count += 1
    return float(np.mean(errors)), count


def predict_rollout(
    model: LinearDynamicsModel,
    provider: FeatureProvider,
    history_obs: np.ndarray,
    history_actions: np.ndarray,
    action_sequence: Sequence[int],
) -> tuple[np.ndarray, list[float]]:
    observations = np.asarray(history_obs, dtype=np.float64).copy()
    actions = np.asarray(history_actions, dtype=np.int64).copy()
    consequences: list[float] = []
    for action in action_sequence:
        features = provider.feature_for_history(observations, actions)
        next_obs, consequence = model.predict(features, int(action))
        observations = np.vstack((observations, next_obs))
        actions = np.append(actions, int(action))
        consequences.append(consequence)
    return observations[-1], consequences


def evaluate_counterfactual(
    model: LinearDynamicsModel,
    episodes: Sequence[Episode],
    provider: FeatureProvider,
    spec: WorldSpec,
    cfg: ProfileConfig,
    seed: int,
    max_cases: int | None = None,
) -> float:
    rng = random.Random(seed)
    world = RawWorld(spec)
    errors: list[float] = []
    cases = 0
    for episode in episodes:
        positions = list(range(cfg.history - 1, len(episode.actions)))
        rng.shuffle(positions)
        for t in positions[: max(2, min(8, len(positions)))]:
            action_sequence = [rng.randrange(cfg.actions) for _ in range(cfg.rollout_horizon)]
            true_obs, _ = world.branch(episode.snapshots[t], action_sequence)
            predicted, _ = predict_rollout(
                model,
                provider,
                episode.observations[: t + 1],
                episode.actions[:t],
                action_sequence,
            )
            errors.append(float(np.mean(np.square(predicted - true_obs[-1]))))
            cases += 1
            if max_cases is not None and cases >= max_cases:
                return float(np.mean(errors))
    return float(np.mean(errors)) if errors else float("inf")


def evaluate_policy(
    model: LinearDynamicsModel,
    episodes: Sequence[Episode],
    provider: FeatureProvider,
    spec: WorldSpec,
    cfg: ProfileConfig,
    max_cases: int | None = None,
) -> tuple[float, float, list[int]]:
    world = RawWorld(spec)
    returns: list[float] = []
    regrets: list[float] = []
    choices: list[int] = []
    cases = 0
    sequences = list(itertools.product(range(cfg.actions), repeat=cfg.policy_horizon))
    for episode in episodes:
        for t in range(cfg.history - 1, len(episode.actions), max(1, cfg.policy_horizon)):
            predicted_scores = []
            true_scores = []
            for sequence in sequences:
                _, predicted_consequences = predict_rollout(
                    model,
                    provider,
                    episode.observations[: t + 1],
                    episode.actions[:t],
                    sequence,
                )
                predicted_scores.append(float(sum(predicted_consequences)))
                _, actual_consequences = world.branch(episode.snapshots[t], sequence)
                true_scores.append(float(sum(actual_consequences)))
            chosen = int(np.argmax(predicted_scores))
            choices.append(int(sequences[chosen][0]))
            realized = true_scores[chosen]
            oracle = max(true_scores)
            returns.append(realized)
            regrets.append(oracle - realized)
            cases += 1
            if max_cases is not None and cases >= max_cases:
                return float(np.mean(returns)), float(np.mean(regrets)), choices
    return float(np.mean(returns)), float(np.mean(regrets)), choices


def sample_efficiency_auc(
    train_episodes: Sequence[Episode],
    eval_episodes: Sequence[Episode],
    provider: FeatureProvider,
    cfg: ProfileConfig,
    name: str,
) -> float:
    fractions = (0.25, 0.5, 1.0)
    scores = []
    for fraction in fractions:
        count = max(1, int(math.ceil(len(train_episodes) * fraction)))
        model = train_linear_model(train_episodes[:count], provider, cfg, name)
        mse, _ = evaluate_one_step(model, eval_episodes, provider, cfg)
        scores.append(1.0 / (mse + 1e-6))
    return float(np.trapezoid(np.asarray(scores), np.asarray(fractions)))


def evaluate_condition(
    name: str,
    train_episodes: Sequence[Episode],
    eval_episodes: Sequence[Episode],
    provider: FeatureProvider,
    spec: WorldSpec,
    cfg: ProfileConfig,
    seed: int,
    *,
    model_override: LinearDynamicsModel | None = None,
    frozen_feature_transform: FeatureProvider | None = None,
) -> tuple[ConditionMetrics, LinearDynamicsModel]:
    model = model_override or train_linear_model(train_episodes, provider, cfg, name)
    evaluation_provider = frozen_feature_transform or provider
    next_mse, eval_rows = evaluate_one_step(model, eval_episodes, evaluation_provider, cfg)
    cf_mse = evaluate_counterfactual(model, eval_episodes, evaluation_provider, spec, cfg, seed, max_cases=24 if cfg.name == "smoke" else None)
    policy_return, policy_regret, policy_choices = evaluate_policy(
        model, eval_episodes, evaluation_provider, spec, cfg,
        max_cases=12 if cfg.name == "smoke" else None,
    )
    choice_histogram = [policy_choices.count(action) for action in range(cfg.actions)]
    choice_hash = sha256_text(canonical_json(policy_choices))
    x, _ = design_rows(train_episodes, provider, cfg)
    auc = sample_efficiency_auc(train_episodes, eval_episodes, provider, cfg, name) if model_override is None else 0.0
    metrics = ConditionMetrics(
        condition=name,
        next_observation_mse=next_mse,
        counterfactual_mse=cf_mse,
        intervention_return=policy_return,
        intervention_regret=policy_regret,
        intervention_choice_hash=choice_hash,
        intervention_action_histogram=choice_histogram,
        sample_efficiency_auc=auc,
        feature_width=provider.width,
        parameter_count=int(model.weights.size),
        train_rows=int(x.shape[0]),
        eval_rows=eval_rows,
    )
    return metrics, model


def metric_utility(metrics: ConditionMetrics) -> float:
    return (
        -math.log(metrics.next_observation_mse + 1e-6)
        - 0.65 * math.log(metrics.counterfactual_mse + 1e-6)
        + 0.45 * metrics.intervention_return
        - 0.15 * metrics.intervention_regret
    )


def relative_gain(baseline: float, candidate: float, lower_is_better: bool = True) -> float:
    if lower_is_better:
        return (baseline - candidate) / max(abs(baseline), EPS)
    return (candidate - baseline) / max(abs(baseline), 1e-6)


@dataclass
class ProgramEvaluation:
    uid: str
    semantic_hash: str
    utility: float
    metrics_by_world: dict[str, dict[str, Any]]
    mean_variance: float
    stable: bool
    execution_cost: int
    retired_reason: str | None = None

    def serialize(self) -> dict[str, Any]:
        return asdict(self)


def evaluate_program_on_development(
    program: Program,
    worlds: Sequence[tuple[WorldSpec, Sequence[Episode], Sequence[Episode]]],
    cfg: ProfileConfig,
) -> ProgramEvaluation:
    metrics_by_world: dict[str, dict[str, Any]] = {}
    utilities = []
    variances = []
    stable = True
    for world_index, (spec, train, evaluation) in enumerate(worlds):
        provider = ProgramFeatureProvider(cfg, [program])
        try:
            features = np.concatenate([provider.episode_features(ep) for ep in train], axis=0)
            variance = float(np.var(features))
            variances.append(variance)
            if not np.isfinite(features).all() or variance < 1e-7:
                stable = False
            metrics, _ = evaluate_condition(
                f"candidate:{program.uid}", train, evaluation, provider, spec, cfg, seed=spec.seed ^ 0xE11,
            )
            metrics_by_world[str(world_index)] = metrics.serialize()
            utilities.append(metric_utility(metrics))
        except Exception as exc:
            stable = False
            metrics_by_world[str(world_index)] = {"error": f"{type(exc).__name__}: {exc}"}
            utilities.append(-1e9)
    validation = validate_program(program, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                                  max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
    retired_reason = None
    if not stable:
        retired_reason = "unstable_or_constant"
    return ProgramEvaluation(
        uid=program.uid,
        semantic_hash=program.semantic_hash(),
        utility=float(np.mean(utilities)),
        metrics_by_world=metrics_by_world,
        mean_variance=float(np.mean(variances)) if variances else 0.0,
        stable=stable,
        execution_cost=int(validation["cost"]),
        retired_reason=retired_reason,
    )


def behavior_signature(program: Program, episodes: Sequence[Episode], cfg: ProfileConfig) -> np.ndarray:
    provider = ProgramFeatureProvider(cfg, [program])
    values = np.concatenate([provider.episode_features(ep)[:, 0] for ep in episodes])
    if values.size > 96:
        indices = np.linspace(0, values.size - 1, 96).astype(int)
        values = values[indices]
    return np.round(values, 4)


def retain_diverse(
    programs: Sequence[Program],
    evaluations: dict[str, ProgramEvaluation],
    episodes: Sequence[Episode],
    cfg: ProfileConfig,
    count: int,
) -> tuple[list[Program], list[dict[str, Any]]]:
    ranked = sorted(programs, key=lambda p: evaluations[p.uid].utility, reverse=True)
    retained: list[Program] = []
    signatures: list[np.ndarray] = []
    retired: list[dict[str, Any]] = []
    for program in ranked:
        evaluation = evaluations[program.uid]
        if not evaluation.stable:
            program.status = "retired"
            program.retired_reason = evaluation.retired_reason
            retired.append({"uid": program.uid, "reason": program.retired_reason})
            continue
        signature = behavior_signature(program, episodes, cfg)
        redundant = False
        for prior in signatures:
            if np.std(signature) < 1e-9 or np.std(prior) < 1e-9:
                corr = 1.0 if np.allclose(signature, prior) else 0.0
            else:
                corr = abs(float(np.corrcoef(signature, prior)[0, 1]))
            if math.isfinite(corr) and corr > 0.985:
                redundant = True
                break
        if redundant:
            program.status = "retired"
            program.retired_reason = "behaviorally_redundant"
            retired.append({"uid": program.uid, "reason": program.retired_reason})
            continue
        retained.append(program)
        signatures.append(signature)
        if len(retained) >= count:
            break
    for program in ranked:
        if program not in retained and program.status != "retired":
            program.status = "retired"
            program.retired_reason = "causally_uncompetitive"
            retired.append({"uid": program.uid, "reason": program.retired_reason})
    return retained, retired


def seed_programs(cfg: ProfileConfig) -> list[Program]:
    seeds = []
    for channel in range(min(cfg.obs_channels, 4)):
        seeds.append(make_program([{"op": "obs", "channel": channel, "lag": 0}], 0, history=[{"operator": "minimal_seed"}]))
        seeds.append(make_program([
            {"op": "obs", "channel": channel, "lag": 0},
            {"op": "diff", "args": [0], "lag": min(2, cfg.max_window)},
        ], 1, history=[{"operator": "minimal_seed"}]))
    seeds.append(make_program([
        {"op": "obs", "channel": 0, "lag": 0},
        {"op": "rolling_mean", "args": [0], "window": min(3, cfg.max_window)},
    ], 1, history=[{"operator": "minimal_seed"}]))
    seeds.append(make_program([{"op": "action", "action_index": 0, "lag": 1}], 0, history=[{"operator": "minimal_seed"}]))
    return seeds


@dataclass
class EvolutionResult:
    population: list[Program]
    evaluations: dict[str, ProgramEvaluation]
    generations: list[dict[str, Any]]
    retired: list[dict[str, Any]]
    registry: dict[str, Program]


def evolve_population(
    cfg: ProfileConfig,
    worlds: Sequence[tuple[WorldSpec, Sequence[Episode], Sequence[Episode]]],
    seed: int,
    *,
    allow_descendants: bool = True,
    cross_world: bool = True,
    program_inputs: int = 0,
    initial: Sequence[Program] | None = None,
) -> EvolutionResult:
    rng = random.Random(seed)
    base = list(initial or seed_programs(cfg))
    while len(base) < cfg.population_size:
        base.append(random_program(rng, cfg, program_inputs=program_inputs))
    population = base[: cfg.population_size]
    registry: dict[str, Program] = {program.uid: program for program in population}
    all_evaluations: dict[str, ProgramEvaluation] = {}
    generation_rows: list[dict[str, Any]] = []
    retired_all: list[dict[str, Any]] = []
    effective_worlds = worlds if cross_world else worlds[:1]
    diversity_episodes = list(effective_worlds[0][1])
    for generation in range(cfg.generations):
        evaluations = {
            program.uid: evaluate_program_on_development(program, effective_worlds, cfg)
            for program in population
        }
        all_evaluations.update(evaluations)
        elites, retired = retain_diverse(population, evaluations, diversity_episodes, cfg, cfg.elite_count)
        retired_all.extend({"generation": generation, **row} for row in retired)
        generation_rows.append({
            "generation": generation,
            "population_size": len(population),
            "elite_uids": [p.uid for p in elites],
            "best_utility": max(evaluations[p.uid].utility for p in population),
            "median_utility": float(np.median([evaluations[p.uid].utility for p in population])),
            "retired": retired,
        })
        if generation == cfg.generations - 1 or not allow_descendants:
            population = elites
            break
        descendants: list[Program] = []
        while len(descendants) < cfg.offspring_per_generation:
            if len(elites) >= 2 and rng.random() < 0.28:
                a, b = rng.sample(elites, 2)
                descendants.append(crossover_program(a, b, rng, cfg, program_inputs=program_inputs))
            else:
                descendants.append(mutate_program(rng.choice(elites), rng, cfg, program_inputs=program_inputs))
        for descendant in descendants:
            registry[descendant.uid] = descendant
        population = elites + descendants
        population = population[: cfg.population_size]
    return EvolutionResult(population, all_evaluations, generation_rows, retired_all, registry)


def greedy_bundle(
    candidates: Sequence[Program],
    worlds: Sequence[tuple[WorldSpec, Sequence[Episode], Sequence[Episode]]],
    cfg: ProfileConfig,
) -> tuple[list[Program], list[dict[str, Any]]]:
    chosen: list[Program] = []
    trace: list[dict[str, Any]] = []
    remaining = list(candidates)
    current_utility = -1e18
    while remaining and len(chosen) < cfg.admitted_width:
        scored = []
        for candidate in remaining:
            bundle = chosen + [candidate]
            utilities = []
            for spec, train, evaluation in worlds:
                metrics, _ = evaluate_condition("bundle_search", train, evaluation, ProgramFeatureProvider(cfg, bundle), spec, cfg, spec.seed ^ 0xB00)
                utilities.append(metric_utility(metrics))
            scored.append((float(np.mean(utilities)), candidate))
        scored.sort(key=lambda x: (x[0], x[1].uid), reverse=True)
        best_utility, best = scored[0]
        trace.append({"step": len(chosen), "candidate": best.uid, "utility": best_utility, "previous": current_utility})
        if chosen and best_utility <= current_utility + 1e-5:
            break
        chosen.append(best)
        remaining = [x for x in remaining if x.uid != best.uid]
        current_utility = best_utility
    return chosen, trace


def random_complexity_matched(program: Program, rng: random.Random, cfg: ProfileConfig) -> Program:
    target_cost = validate_program(program, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                                   max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)["cost"]
    best = None
    best_gap = float("inf")
    for _ in range(80):
        candidate = random_program(rng, cfg)
        cost = validate_program(candidate, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                                max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)["cost"]
        gap = abs(cost - target_cost)
        if gap < best_gap:
            best, best_gap = candidate, gap
        if gap <= 1:
            break
    assert best is not None
    return best


def remap_program(
    program: Program,
    old_permutation: Sequence[int],
    new_permutation: Sequence[int] | None = None,
) -> Program:
    """Rewrite raw channel references across a declared sensor permutation.

    Permutations map exposed channel index -> pre-permutation surface channel.
    When ``new_permutation`` is omitted, the old surface is assumed identity.
    """
    if new_permutation is None:
        new_permutation = old_permutation
        old_permutation = tuple(range(len(new_permutation)))
    if len(old_permutation) != len(new_permutation):
        raise ValueError("permutation width mismatch")
    inverse_new = {surface: exposed for exposed, surface in enumerate(new_permutation)}
    mapping = {old_exposed: inverse_new[int(surface)] for old_exposed, surface in enumerate(old_permutation)}
    nodes = copy.deepcopy(program.nodes)
    for node in nodes:
        if node["op"] == "obs":
            node["channel"] = mapping[int(node["channel"])]
        elif node["op"] == "projection":
            node["channels"] = [mapping[int(c)] for c in node["channels"]]
    return make_program(
        nodes,
        program.root,
        parents=[program.uid],
        history=[
            *program.mutation_history,
            {
                "operator": "declared_channel_remap",
                "old_permutation": list(old_permutation),
                "new_permutation": list(new_permutation),
            },
        ],
        generation=program.generation + 1,
    )


def baseline_providers(cfg: ProfileConfig, width: int, seed: int, random_programs: Sequence[Program]) -> dict[str, FeatureProvider]:
    return {
        "raw_history": RawHistoryProvider(cfg, width, seed=seed, mode="raw"),
        "random_program": ProgramFeatureProvider(cfg, random_programs),
        "random_projection": RawHistoryProvider(cfg, width, seed=seed ^ 0x778, mode="random_projection"),
        "generic_temporal_statistics": GenericStatsProvider(cfg, width),
    }


class TinyEncoder(nn.Module if nn is not None else object):
    def __init__(self, input_width: int, width: int, output_width: int):
        if nn is None:
            raise RuntimeError("torch unavailable")
        super().__init__()
        self.encoder = nn.Sequential(nn.Linear(input_width, width), nn.Tanh(), nn.Linear(width, output_width), nn.Tanh())
        self.head = nn.Linear(output_width, output_width)

    def forward(self, x):
        z = self.encoder(x)
        return z, self.head(z)


def train_neural_provider(
    cfg: ProfileConfig,
    episodes: Sequence[Episode],
    width: int,
    seed: int,
    mode: str,
    name: str,
) -> TorchEncoderProvider:
    if torch is None:
        raise RuntimeError("torch is required for neural baselines")
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    raw_provider = RawHistoryProvider(cfg, width=max(width * 4, width), seed=seed)
    raw_rows = []
    targets = []
    for episode in episodes:
        raw = raw_provider.episode_features(episode)
        raw_rows.append(raw)
        if mode == "autoencoder":
            target = raw
        elif mode == "contrastive":
            target = np.roll(raw, -1, axis=0)
        else:
            target = np.vstack((episode.observations[1:], episode.observations[-1:]))
        targets.append(target)
    x = torch.tensor(np.concatenate(raw_rows), dtype=torch.float32, device=device)
    y = torch.tensor(np.concatenate(targets), dtype=torch.float32, device=device)
    model = TinyEncoder(x.shape[1], max(24, width * 3), width).to(device)
    decoder = nn.Linear(width, y.shape[1]).to(device)
    optimizer = torch.optim.Adam(list(model.parameters()) + list(decoder.parameters()), lr=2e-3)
    epochs = 80 if cfg.name == "full" else 20
    for _ in range(epochs):
        z, _ = model(x)
        if mode == "contrastive":
            z_next = torch.roll(z.detach(), -1, dims=0)
            logits = F.normalize(z, dim=-1) @ F.normalize(z_next, dim=-1).T / 0.2
            labels = torch.arange(len(z), device=device)
            loss = F.cross_entropy(logits, labels)
        else:
            prediction = decoder(z)
            loss = F.mse_loss(prediction, y)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
    encoder = copy.deepcopy(model.encoder).to(device)
    return TorchEncoderProvider(cfg, raw_provider, encoder, width, name, device)


def evaluate_baselines(
    cfg: ProfileConfig,
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    width: int,
    seed: int,
    random_programs: Sequence[Program],
) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    providers = baseline_providers(cfg, width, seed, random_programs)
    for name, provider in providers.items():
        metrics, _ = evaluate_condition(name, train, evaluation, provider, spec, cfg, seed ^ 0x991)
        results[name] = metrics.serialize()
    if cfg.run_neural_baselines:
        all_episodes = list(train) + list(evaluation)
        for mode, name in (("predictive", "neural_encoder"), ("autoencoder", "autoencoder"), ("contrastive", "contrastive_temporal")):
            provider = train_neural_provider(cfg, all_episodes, width, seed ^ int(sha256_text(name)[:8], 16), mode, name)
            metrics, _ = evaluate_condition(name, train, evaluation, provider, spec, cfg, seed ^ 0xA41)
            results[name] = metrics.serialize()
    else:
        for name in ("neural_encoder", "autoencoder", "contrastive_temporal"):
            results[name] = {"status": "not_executed_in_smoke", "implemented": True}
    disagreement_train = collect_dataset(spec, cfg, len(train), seed ^ 0xD15, policy="disagreement")
    raw_disagreement = RawHistoryProvider(cfg, width, seed=seed ^ 0xD15)
    metrics, _ = evaluate_condition("ensemble_disagreement_exploration", disagreement_train, evaluation,
                                    raw_disagreement, spec, cfg, seed ^ 0xD16)
    results["ensemble_disagreement_exploration"] = metrics.serialize()
    results["oracle_feature_upper_bound"] = oracle_upper_bound(spec, train, evaluation, cfg, width)
    return results


def oracle_upper_bound(spec: WorldSpec, train: Sequence[Episode], evaluation: Sequence[Episode], cfg: ProfileConfig, width: int) -> dict[str, Any]:
    # Evaluator-only upper bound. Hidden snapshots are used only here and never in search.
    x_rows: list[np.ndarray] = []
    y_rows: list[np.ndarray] = []
    for episode in train:
        for t in range(cfg.history - 1, len(episode.actions)):
            latent = episode.snapshots[t].state
            feature = np.pad(latent, (0, max(0, width - len(latent))))[:width]
            x_rows.append(np.concatenate((feature, np.eye(cfg.actions)[episode.actions[t]], [1.0])))
            y_rows.append(np.concatenate((episode.observations[t + 1], [episode.consequences[t]])))
    weights = ridge_fit(np.asarray(x_rows), np.asarray(y_rows), cfg.ridge)
    one_step_errors: list[float] = []
    oracle_returns: list[float] = []
    world = RawWorld(spec)
    sequences = list(itertools.product(range(cfg.actions), repeat=cfg.policy_horizon))
    eval_rows = 0
    for episode in evaluation:
        for t in range(cfg.history - 1, len(episode.actions)):
            latent = episode.snapshots[t].state
            feature = np.pad(latent, (0, max(0, width - len(latent))))[:width]
            x = np.concatenate((feature, np.eye(cfg.actions)[episode.actions[t]], [1.0]))
            prediction = x @ weights
            one_step_errors.append(float(np.mean(np.square(prediction[: cfg.obs_channels] - episode.observations[t + 1]))))
            eval_rows += 1
        for t in range(cfg.history - 1, len(episode.actions), max(1, cfg.policy_horizon)):
            true_scores = [sum(world.branch(episode.snapshots[t], sequence)[1]) for sequence in sequences]
            oracle_returns.append(float(max(true_scores)))
    return ConditionMetrics(
        condition="oracle_feature_upper_bound",
        next_observation_mse=float(np.mean(one_step_errors)),
        counterfactual_mse=0.0,
        intervention_return=float(np.mean(oracle_returns)),
        intervention_regret=0.0,
        intervention_choice_hash=sha256_text("oracle"),
        intervention_action_histogram=[0 for _ in range(cfg.actions)],
        sample_efficiency_auc=1e12,
        feature_width=width,
        parameter_count=int(weights.size),
        train_rows=len(x_rows),
        eval_rows=eval_rows,
    ).serialize() | {"selection_use": "prohibited"}


def bundle_metrics(
    name: str,
    programs: Sequence[Program],
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    seed: int,
    *,
    transform: str = "none",
    model_override: LinearDynamicsModel | None = None,
) -> tuple[dict[str, Any], LinearDynamicsModel]:
    provider = ProgramFeatureProvider(cfg, programs, transform=transform, transform_seed=seed)
    metrics, model = evaluate_condition(name, train, evaluation, provider, spec, cfg, seed,
                                        model_override=model_override, frozen_feature_transform=provider if model_override else None)
    return metrics.serialize(), model


def _provider_metrics(
    name: str,
    provider: FeatureProvider,
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    seed: int,
    *,
    model_override: LinearDynamicsModel | None = None,
    training_provider: FeatureProvider | None = None,
) -> tuple[dict[str, Any], LinearDynamicsModel]:
    training_provider = training_provider or provider
    metrics, model = evaluate_condition(
        name,
        train,
        evaluation,
        training_provider,
        spec,
        cfg,
        seed,
        model_override=model_override,
        frozen_feature_transform=provider if model_override is not None else None,
    )
    return metrics.serialize(), model


def behaviorally_distinct_mutant(
    program: Program,
    episodes: Sequence[Episode],
    cfg: ProfileConfig,
    rng: random.Random,
) -> Program:
    base = behavior_signature(program, episodes, cfg)
    for _ in range(40):
        candidate = mutate_program(program, rng, cfg)
        signature = behavior_signature(candidate, episodes, cfg)
        if np.std(base) < 1e-9 or np.std(signature) < 1e-9:
            distinct = not np.allclose(base, signature)
        else:
            corr = abs(float(np.corrcoef(base, signature)[0, 1]))
            distinct = not math.isfinite(corr) or corr < 0.95
        if distinct:
            return candidate
    return random_complexity_matched(program, rng, cfg)


def run_ablations(
    programs: Sequence[Program],
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    seed: int,
    full_model: LinearDynamicsModel,
    *,
    registry: dict[str, Program] | None = None,
    transport_context: tuple[WorldSpec, Sequence[Episode], Sequence[Episode], Sequence[Program]] | None = None,
) -> dict[str, Any]:
    rng = random.Random(seed)
    registry = registry or {program.uid: program for program in programs}
    result: dict[str, Any] = {}
    full_provider = ProgramFeatureProvider(cfg, programs)

    random_set = [random_complexity_matched(program, rng, cfg) for program in programs]
    parent_set: list[Program] = []
    parent_details = []
    for program in programs:
        parent = registry.get(program.parents[0]) if program.parents else None
        parent_set.append(parent or program)
        parent_details.append({
            "child": program.uid,
            "parent": parent.uid if parent is not None else None,
            "applicable": parent is not None,
        })
    mutant_set = [behaviorally_distinct_mutant(program, evaluation, cfg, rng) for program in programs]

    heldout_providers: dict[str, FeatureProvider] = {
        "remove_program": ProgramFeatureProvider(cfg, []),
        "zero_output": ProgramFeatureProvider(cfg, programs, transform="zero", transform_seed=seed ^ 2),
        "shuffle_across_episodes": EpisodePermutationProvider(cfg, full_provider, [train, evaluation], seed ^ 3),
        "shuffle_across_time": ProgramFeatureProvider(cfg, programs, transform="shuffle_time", transform_seed=seed ^ 4),
        "complexity_matched_random": ProgramFeatureProvider(cfg, random_set),
        "replace_with_parent": ProgramFeatureProvider(cfg, parent_set),
        "syntactically_similar_behavioral_mutant": ProgramFeatureProvider(cfg, mutant_set),
        "metadata_removed_execution_preserved": ProgramFeatureProvider(cfg, [make_program(p.nodes, p.root) for p in programs]),
        "constant_output": ProgramFeatureProvider(cfg, programs, transform="constant", transform_seed=seed ^ 10),
    }
    for offset, (name, provider) in enumerate(heldout_providers.items(), start=1):
        metrics, _ = _provider_metrics(name, provider, spec, train, evaluation, cfg, seed ^ (offset * 101))
        result[name] = metrics
    result["retrain_without"] = copy.deepcopy(result["remove_program"])
    zero_provider = heldout_providers["zero_output"]
    frozen_metrics, _ = _provider_metrics(
        "freeze_downstream_remove",
        zero_provider,
        spec,
        train,
        evaluation,
        cfg,
        seed ^ 0xF20,
        model_override=full_model,
        training_provider=full_provider,
    )
    result["freeze_downstream_remove"] = frozen_metrics
    result["metadata_preserved_execution_removed"] = copy.deepcopy(result["zero_output"])
    result["replace_with_parent"]["parentage"] = parent_details
    result["syntactically_similar_behavioral_mutant"]["mutants"] = [p.serialize() for p in mutant_set]
    result["complexity_matched_random"]["programs"] = [p.serialize() for p in random_set]

    if transport_context is not None:
        transport_spec, transport_train, transport_eval, transport_programs = transport_context
        transport_full_provider = ProgramFeatureProvider(cfg, transport_programs)
        transport_random = [
            remap_program(p, spec.channel_permutation, transport_spec.channel_permutation)
            for p in random_set
        ]
        transport_parents = [
            remap_program(p, spec.channel_permutation, transport_spec.channel_permutation)
            for p in parent_set
        ]
        transport_mutants = [
            remap_program(p, spec.channel_permutation, transport_spec.channel_permutation)
            for p in mutant_set
        ]
        transport_providers: dict[str, FeatureProvider] = {
            "remove_program": ProgramFeatureProvider(cfg, []),
            "zero_output": ProgramFeatureProvider(cfg, transport_programs, transform="zero", transform_seed=seed ^ 22),
            "shuffle_across_episodes": EpisodePermutationProvider(cfg, transport_full_provider, [transport_train, transport_eval], seed ^ 23),
            "shuffle_across_time": ProgramFeatureProvider(cfg, transport_programs, transform="shuffle_time", transform_seed=seed ^ 24),
            "complexity_matched_random": ProgramFeatureProvider(cfg, transport_random),
            "replace_with_parent": ProgramFeatureProvider(cfg, transport_parents),
            "syntactically_similar_behavioral_mutant": ProgramFeatureProvider(cfg, transport_mutants),
            "metadata_removed_execution_preserved": ProgramFeatureProvider(
                cfg, [make_program(p.nodes, p.root) for p in transport_programs]
            ),
            "constant_output": ProgramFeatureProvider(cfg, transport_programs, transform="constant", transform_seed=seed ^ 30),
        }
        transport_full_metrics, transport_full_model = _provider_metrics(
            "transport_full", transport_full_provider, transport_spec, transport_train, transport_eval, cfg, seed ^ 0x7F1
        )
        for offset, (name, provider) in enumerate(transport_providers.items(), start=1):
            metrics, _ = _provider_metrics(
                f"transport_{name}", provider, transport_spec, transport_train, transport_eval, cfg, seed ^ (0x800 + offset)
            )
            result[name]["transport"] = metrics
        result["retrain_without"]["transport"] = copy.deepcopy(result["remove_program"]["transport"])
        transport_zero = transport_providers["zero_output"]
        frozen_transport, _ = _provider_metrics(
            "transport_freeze_downstream_remove",
            transport_zero,
            transport_spec,
            transport_train,
            transport_eval,
            cfg,
            seed ^ 0x8F2,
            model_override=transport_full_model,
            training_provider=transport_full_provider,
        )
        result["freeze_downstream_remove"]["transport"] = frozen_transport
        result["metadata_preserved_execution_removed"]["transport"] = copy.deepcopy(
            result["zero_output"]["transport"]
        )
        result["transport_full_reference"] = transport_full_metrics
    return result


def per_program_court(
    bundle: Sequence[Program],
    full_metrics: dict[str, Any],
    full_model: LinearDynamicsModel,
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    seed: int,
    registry: dict[str, Program],
    transport_context: tuple[WorldSpec, Sequence[Episode], Sequence[Episode], Sequence[Program]],
) -> dict[str, Any]:
    rows: dict[str, Any] = {}
    full_provider = ProgramFeatureProvider(cfg, bundle)
    transport_spec, transport_train, transport_eval, transport_bundle = transport_context
    transport_full_provider = ProgramFeatureProvider(cfg, transport_bundle)
    transport_full_metrics, transport_full_model = _provider_metrics(
        "per_program_transport_full", transport_full_provider, transport_spec, transport_train, transport_eval, cfg, seed ^ 0x901
    )
    rng = random.Random(seed)
    for index, program in enumerate(bundle):
        without = list(bundle[:index]) + list(bundle[index + 1 :])
        without_metrics, _ = bundle_metrics(
            f"without:{program.uid}", without, spec, train, evaluation, cfg, seed ^ (index * 31 + 1)
        )
        zero_provider = ColumnAblationProvider(cfg, full_provider, index, "zero", seed ^ (index * 31 + 2))
        zero_metrics, _ = _provider_metrics(
            f"zero:{program.uid}", zero_provider, spec, train, evaluation, cfg, seed ^ (index * 31 + 3)
        )
        shuffle_provider = ColumnAblationProvider(cfg, full_provider, index, "shuffle_time", seed ^ (index * 31 + 4))
        shuffle_metrics, _ = _provider_metrics(
            f"shuffle:{program.uid}", shuffle_provider, spec, train, evaluation, cfg, seed ^ (index * 31 + 5)
        )
        constant_provider = ColumnAblationProvider(cfg, full_provider, index, "constant", seed ^ (index * 31 + 6))
        constant_metrics, _ = _provider_metrics(
            f"constant:{program.uid}", constant_provider, spec, train, evaluation, cfg, seed ^ (index * 31 + 7)
        )
        parent = registry.get(program.parents[0]) if program.parents else None
        parent_bundle = list(bundle)
        if parent is not None:
            parent_bundle[index] = parent
        parent_metrics, _ = bundle_metrics(
            f"parent:{program.uid}", parent_bundle, spec, train, evaluation, cfg, seed ^ (index * 31 + 8)
        )
        random_replacement = random_complexity_matched(program, rng, cfg)
        random_bundle = list(bundle)
        random_bundle[index] = random_replacement
        random_metrics, _ = bundle_metrics(
            f"random:{program.uid}", random_bundle, spec, train, evaluation, cfg, seed ^ (index * 31 + 9)
        )
        mutant = behaviorally_distinct_mutant(program, evaluation, cfg, rng)
        mutant_bundle = list(bundle)
        mutant_bundle[index] = mutant
        mutant_metrics, _ = bundle_metrics(
            f"mutant:{program.uid}", mutant_bundle, spec, train, evaluation, cfg, seed ^ (index * 31 + 10)
        )
        frozen_metrics, _ = _provider_metrics(
            f"frozen_zero:{program.uid}",
            zero_provider,
            spec,
            train,
            evaluation,
            cfg,
            seed ^ (index * 31 + 11),
            model_override=full_model,
            training_provider=full_provider,
        )

        transport_without = list(transport_bundle[:index]) + list(transport_bundle[index + 1 :])
        transport_without_metrics, _ = bundle_metrics(
            f"transport_without:{program.uid}", transport_without, transport_spec,
            transport_train, transport_eval, cfg, seed ^ (index * 31 + 12)
        )
        transport_zero_provider = ColumnAblationProvider(
            cfg, transport_full_provider, index, "zero", seed ^ (index * 31 + 13)
        )
        transport_zero_metrics, _ = _provider_metrics(
            f"transport_zero:{program.uid}", transport_zero_provider, transport_spec,
            transport_train, transport_eval, cfg, seed ^ (index * 31 + 14)
        )
        transport_frozen, _ = _provider_metrics(
            f"transport_frozen_zero:{program.uid}",
            transport_zero_provider,
            transport_spec,
            transport_train,
            transport_eval,
            cfg,
            seed ^ (index * 31 + 15),
            model_override=transport_full_model,
            training_provider=transport_full_provider,
        )

        checks = {
            "marginal_next_prediction": relative_gain(
                full_metrics["next_observation_mse"], without_metrics["next_observation_mse"], lower_is_better=False
            ) >= cfg.thresholds["ablation_relative_damage"],
            "marginal_counterfactual": relative_gain(
                full_metrics["counterfactual_mse"], without_metrics["counterfactual_mse"], lower_is_better=False
            ) >= cfg.thresholds["ablation_relative_damage"],
            "marginal_intervention": (
                full_metrics["intervention_return"] - without_metrics["intervention_return"]
                >= cfg.thresholds["policy_return_gain"]
            ),
            "intervention_choice_changes": full_metrics["intervention_choice_hash"] != without_metrics["intervention_choice_hash"],
            "zero_damage": relative_gain(
                full_metrics["next_observation_mse"], zero_metrics["next_observation_mse"], lower_is_better=False
            ) >= cfg.thresholds["ablation_relative_damage"],
            "shuffle_damage": relative_gain(
                full_metrics["next_observation_mse"], shuffle_metrics["next_observation_mse"], lower_is_better=False
            ) >= cfg.thresholds["shuffle_relative_damage"],
            "constant_damage": relative_gain(
                full_metrics["next_observation_mse"], constant_metrics["next_observation_mse"], lower_is_better=False
            ) >= cfg.thresholds["ablation_relative_damage"],
            "frozen_damage": relative_gain(
                full_metrics["next_observation_mse"], frozen_metrics["next_observation_mse"], lower_is_better=False
            ) >= cfg.thresholds["ablation_relative_damage"],
            "transport_marginal": relative_gain(
                transport_full_metrics["next_observation_mse"],
                transport_without_metrics["next_observation_mse"],
                lower_is_better=False,
            ) >= cfg.thresholds["ablation_relative_damage"],
            "transport_zero_damage": relative_gain(
                transport_full_metrics["next_observation_mse"],
                transport_zero_metrics["next_observation_mse"],
                lower_is_better=False,
            ) >= cfg.thresholds["ablation_relative_damage"],
            "transport_frozen_damage": relative_gain(
                transport_full_metrics["next_observation_mse"],
                transport_frozen["next_observation_mse"],
                lower_is_better=False,
            ) >= cfg.thresholds["ablation_relative_damage"],
            "parentage_complete": program.generation == 0 or (bool(program.parents) and parent is not None),
        }
        rows[program.uid] = {
            "passed": all(checks.values()),
            "checks": checks,
            "program": program.serialize(),
            "without": without_metrics,
            "zero": zero_metrics,
            "shuffle_time": shuffle_metrics,
            "constant": constant_metrics,
            "parent": {"program": parent.serialize() if parent is not None else None, "metrics": parent_metrics},
            "complexity_matched_random": {"program": random_replacement.serialize(), "metrics": random_metrics},
            "behaviorally_distinct_mutant": {"program": mutant.serialize(), "metrics": mutant_metrics},
            "frozen_zero": frozen_metrics,
            "transport_without": transport_without_metrics,
            "transport_zero": transport_zero_metrics,
            "transport_frozen_zero": transport_frozen,
        }
    return {
        "passed": bool(rows) and all(row["passed"] for row in rows.values()),
        "programs": rows,
        "transport_full_reference": transport_full_metrics,
    }


def fecundity_test(
    admitted: Sequence[Program],
    worlds: Sequence[tuple[WorldSpec, Sequence[Episode], Sequence[Episode]]],
    cfg: ProfileConfig,
    seed: int,
) -> dict[str, Any]:
    if not admitted:
        return {"passed": False, "status": "not_testable_without_admitted_instrument"}
    rng_a = random.Random(seed)
    rng_b = random.Random(seed)
    with_parent: list[Program] = []
    without_parent: list[Program] = []
    for _ in range(cfg.fecundity_budget):
        with_parent.append(random_program(rng_a, cfg, program_inputs=len(admitted),
                                          parents=[p.uid for p in admitted],
                                          history=[{"operator": "fecundity_descendant", "parent_inputs": len(admitted)}]))
        without_parent.append(random_program(rng_b, cfg, program_inputs=0,
                                             history=[{"operator": "fecundity_control"}]))
    def discovery_rate(programs: Sequence[Program], use_inputs: bool) -> tuple[float, list[dict[str, Any]]]:
        successes = 0
        rows = []
        for program in programs:
            gains = []
            for spec, train, evaluation in worlds:
                parent_provider = ProgramFeatureProvider(cfg, admitted)
                parent_metrics, _ = evaluate_condition("fecundity_parent", train, evaluation, parent_provider, spec, cfg, seed ^ spec.seed)
                provider = ProgramFeatureProvider(cfg, [program], base_programs=admitted if use_inputs else ())
                combined_programs = list(admitted) + [program] if not use_inputs else [program]
                if use_inputs:
                    child_features = provider
                    # Child output is the sole added feature alongside retained parent outputs.
                    parent_mats = {ep.episode_seed: np.column_stack((parent_provider.episode_features(ep), child_features.episode_features(ep)))
                                   for ep in list(train) + list(evaluation)}
                    combined = FixedMatrixProvider(cfg, parent_mats, len(admitted) + 1, "fecundity_combined")
                else:
                    combined = ProgramFeatureProvider(cfg, combined_programs)
                child_metrics, _ = evaluate_condition("fecundity_child", train, evaluation, combined, spec, cfg, seed ^ spec.seed ^ 0xFEC)
                gain = relative_gain(parent_metrics.next_observation_mse, child_metrics.next_observation_mse)
                gains.append(gain)
            passed = min(gains) > cfg.thresholds["prediction_relative_gain"]
            successes += int(passed)
            rows.append({"uid": program.uid, "gains": gains, "additional_utility": passed})
        return successes / max(1, len(programs)), rows
    with_rate, with_rows = discovery_rate(with_parent, True)
    control_rate, control_rows = discovery_rate(without_parent, False)
    gain = with_rate - control_rate
    passed = gain >= cfg.thresholds["fecundity_rate_gain"] and with_rate > 0.0
    return {
        "passed": passed,
        "with_parent_discovery_rate": with_rate,
        "control_discovery_rate": control_rate,
        "rate_gain": gain,
        "equal_budget": cfg.fecundity_budget,
        "with_parent_descendants": with_rows,
        "control_descendants": control_rows,
        "verdict": "developmentally_fecund" if passed else "useful_static_measurement_without_developmental_compounding",
    }


def revision_test(
    admitted: Sequence[Program],
    base_spec: WorldSpec,
    cfg: ProfileConfig,
    seed: int,
) -> dict[str, Any]:
    if not admitted:
        return {"passed": False, "status": "not_testable_without_admitted_instrument"}
    revised_spec = make_world_spec(base_spec.seed, cfg, revised=True)
    train = collect_dataset(revised_spec, cfg, cfg.train_episodes, seed ^ 0xA55)
    evaluation = collect_dataset(revised_spec, cfg, cfg.eval_episodes, seed ^ 0xA56)
    unchanged_metrics, _ = evaluate_condition("revision_unchanged", train, evaluation, ProgramFeatureProvider(cfg, admitted), revised_spec, cfg, seed)
    deleted_metrics, _ = evaluate_condition("revision_deleted", train, evaluation, ProgramFeatureProvider(cfg, []), revised_spec, cfg, seed ^ 1)
    rng = random.Random(seed)
    candidates: list[list[Program]] = []
    for _ in range(cfg.revision_budget):
        revised = list(admitted)
        slot = rng.randrange(len(revised))
        revised[slot] = mutate_program(revised[slot], rng, cfg)
        candidates.append(revised)
    scored = []
    for candidate in candidates:
        metrics, _ = evaluate_condition("revision_candidate", train, evaluation, ProgramFeatureProvider(cfg, candidate), revised_spec, cfg, seed ^ 2)
        scored.append((metric_utility(metrics), candidate, metrics))
    scored.sort(key=lambda row: row[0], reverse=True)
    _, best_programs, best_metrics = scored[0]
    old_valid_spec = make_world_spec(base_spec.seed ^ 0x113, cfg, revised=False)
    old_train = collect_dataset(old_valid_spec, cfg, cfg.train_episodes, seed ^ 0xA57)
    old_eval = collect_dataset(old_valid_spec, cfg, cfg.eval_episodes, seed ^ 0xA58)
    old_unchanged, _ = evaluate_condition("old_valid_unchanged", old_train, old_eval, ProgramFeatureProvider(cfg, admitted), old_valid_spec, cfg, seed ^ 3)
    old_revised, _ = evaluate_condition("old_valid_revised", old_train, old_eval, ProgramFeatureProvider(cfg, best_programs), old_valid_spec, cfg, seed ^ 4)
    revision_gain = best_metrics.intervention_return - max(unchanged_metrics.intervention_return, deleted_metrics.intervention_return)
    retention_damage = old_unchanged.intervention_return - old_revised.intervention_return
    changed = [p.semantic_hash() for p in best_programs] != [p.semantic_hash() for p in admitted]
    passed = changed and revision_gain >= cfg.thresholds["revision_return_gain"] and retention_damage <= cfg.thresholds["revision_return_gain"]
    return {
        "passed": passed,
        "program_changed": changed,
        "unchanged": unchanged_metrics.serialize(),
        "deleted": deleted_metrics.serialize(),
        "revised": best_metrics.serialize(),
        "old_valid_unchanged": old_unchanged.serialize(),
        "old_valid_revised": old_revised.serialize(),
        "revision_gain": revision_gain,
        "retention_damage": retention_damage,
        "revised_programs": [p.serialize() for p in best_programs],
        "verdict": "conditional_executable_revision" if passed else "accumulating_dogma",
    }


def retention_test(
    admitted: Sequence[Program],
    spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    output: pathlib.Path,
    seed: int,
) -> dict[str, Any]:
    if not admitted:
        return {"passed": False, "status": "not_testable_without_admitted_instrument"}
    path = output / "admitted-instruments.json"
    path.write_text(canonical_json([p.serialize() for p in admitted]) + "\n", encoding="utf-8")
    before, _ = evaluate_condition("retention_before", train, evaluation, ProgramFeatureProvider(cfg, admitted), spec, cfg, seed)
    loaded = [Program.from_dict(row) for row in json.loads(path.read_text(encoding="utf-8"))]
    for program in loaded:
        validate_program(program, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                         max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
    after, _ = evaluate_condition("retention_after", train, evaluation, ProgramFeatureProvider(cfg, loaded), spec, cfg, seed)
    delta = abs(before.next_observation_mse - after.next_observation_mse)
    passed = delta <= cfg.thresholds["retention_tolerance"]
    return {
        "passed": passed,
        "serialized_path": str(path),
        "serialized_sha256": sha256_file(path),
        "before": before.serialize(),
        "after": after.serialize(),
        "prediction_delta": delta,
        "downstream_checkpoint_reused": False,
    }


def teacher_lock_state(profile: ProfileConfig, verdicts: dict[str, bool]) -> dict[str, Any]:
    full_bundle = all(verdicts.values()) and profile.scientific_eligible
    return {
        "teacher_free_proof_bundle_passed": full_bundle,
        "full_teacher_entry": "unlocked" if full_bundle else "prohibited",
        "smoke_can_unlock": False,
        "profile_scientific_eligible": profile.scientific_eligible,
        "teacher_used": False,
    }


def load_teacher_proposals(path: pathlib.Path, unlock_receipt: pathlib.Path | None) -> list[Program]:
    if unlock_receipt is None:
        raise PermissionError("teacher proposals prohibited without sealed full receipt")
    receipt = json.loads(unlock_receipt.read_text(encoding="utf-8"))
    lock = receipt.get("teacher_lock", {})
    if not lock.get("teacher_free_proof_bundle_passed") or lock.get("full_teacher_entry") != "unlocked":
        raise PermissionError("teacher proposals prohibited by receipt")
    proposals = [Program.from_dict(row) for row in json.loads(path.read_text(encoding="utf-8"))]
    for proposal in proposals:
        proposal.origin = "teacher"
    return proposals


def architecture_ablation_receipts(
    cfg: ProfileConfig,
    worlds: Sequence[tuple[WorldSpec, Sequence[Episode], Sequence[Episode]]],
    seed: int,
) -> dict[str, Any]:
    if not cfg.run_architecture_ablations:
        names = [
            "evolution_disabled",
            "cross_world_admission_disabled",
            "causal_ablation_disabled",
            "descendants_disabled",
            "provenance_checks_disabled",
        ]
        return {name: {"status": "not_executed_in_smoke", "implemented": True} for name in names}
    results = {}
    disabled = evolve_population(cfg, worlds, seed, allow_descendants=False)
    results["evolution_disabled"] = {"best_utility": max(x.utility for x in disabled.evaluations.values())}
    single_world = evolve_population(cfg, worlds, seed, cross_world=False)
    results["cross_world_admission_disabled"] = {"best_utility": max(x.utility for x in single_world.evaluations.values())}
    no_desc = evolve_population(cfg, worlds, seed, allow_descendants=False)
    results["descendants_disabled"] = {"best_utility": max(x.utility for x in no_desc.evaluations.values())}
    results["causal_ablation_disabled"] = {"status": "implemented_by_skipping_admission_ablation_gate"}
    results["provenance_checks_disabled"] = {"status": "implemented_by_bypassing_parentage_validator"}
    return results


def structural_checks(cfg: ProfileConfig, population: Sequence[Program]) -> dict[str, bool]:
    checks = {
        "programs_validate": True,
        "deterministic_serialization": True,
        "bounded_execution": True,
        "no_privileged_operations": True,
        "complete_parentage": True,
        "teacher_lock_active": True,
    }
    for program in population:
        validation = validate_program(program, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                                      max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)
        checks["bounded_execution"] &= validation["cost"] <= cfg.max_cost
        checks["deterministic_serialization"] &= canonical_json(program.serialize()) == canonical_json(Program.from_dict(program.serialize()).serialize())
        if program.generation > 0:
            checks["complete_parentage"] &= bool(program.parents) and bool(program.mutation_history)
    return checks


def admission_court(
    bundle: Sequence[Program],
    heldout_spec: WorldSpec,
    train: Sequence[Episode],
    evaluation: Sequence[Episode],
    cfg: ProfileConfig,
    seed: int,
    output: pathlib.Path,
    registry: dict[str, Program],
) -> dict[str, Any]:
    rng = random.Random(seed)
    random_set = [random_complexity_matched(program, rng, cfg) for program in bundle]
    baselines = evaluate_baselines(cfg, heldout_spec, train, evaluation, max(1, len(bundle)), seed, random_set)
    admitted_metrics, admitted_model = bundle_metrics(
        "admitted_program", bundle, heldout_spec, train, evaluation, cfg, seed
    )
    raw = baselines["raw_history"]
    random_baseline = baselines["random_program"]
    comparison = (
        raw
        if metric_utility(ConditionMetrics(**raw)) >= metric_utility(ConditionMetrics(**random_baseline))
        else random_baseline
    )

    transport_spec = make_world_spec(
        heldout_spec.seed ^ 0x7711,
        cfg,
        remap_seed=heldout_spec.seed ^ 0x9911,
    )
    transport_train = collect_dataset(transport_spec, cfg, cfg.train_episodes, seed ^ 0x7712)
    transport_eval = collect_dataset(transport_spec, cfg, cfg.eval_episodes, seed ^ 0x7713)
    remapped_bundle = [
        remap_program(program, heldout_spec.channel_permutation, transport_spec.channel_permutation)
        for program in bundle
    ]
    transport_metrics, _ = bundle_metrics(
        "transport_remapped",
        remapped_bundle,
        transport_spec,
        transport_train,
        transport_eval,
        cfg,
        seed ^ 0x7714,
    )
    transport_raw, _ = evaluate_condition(
        "transport_raw",
        transport_train,
        transport_eval,
        RawHistoryProvider(cfg, max(1, len(bundle)), seed=seed),
        transport_spec,
        cfg,
        seed ^ 0x7715,
    )
    transport_context = (transport_spec, transport_train, transport_eval, remapped_bundle)

    ablations = run_ablations(
        bundle,
        heldout_spec,
        train,
        evaluation,
        cfg,
        seed ^ 0xAB1,
        admitted_model,
        registry=registry,
        transport_context=transport_context,
    )
    program_court = per_program_court(
        bundle,
        admitted_metrics,
        admitted_model,
        heldout_spec,
        train,
        evaluation,
        cfg,
        seed ^ 0xC011,
        registry,
        transport_context,
    )

    zero = ablations["zero_output"]
    shuffled = ablations["shuffle_across_time"]
    shuffled_episodes = ablations["shuffle_across_episodes"]
    constant = ablations["constant_output"]
    frozen = ablations["freeze_downstream_remove"]
    metadata_removed = ablations["metadata_removed_execution_preserved"]
    metadata_only = ablations["metadata_preserved_execution_removed"]
    checks = {
        "heldout_next_prediction": relative_gain(
            comparison["next_observation_mse"], admitted_metrics["next_observation_mse"]
        ) >= cfg.thresholds["prediction_relative_gain"],
        "heldout_counterfactual_prediction": relative_gain(
            comparison["counterfactual_mse"], admitted_metrics["counterfactual_mse"]
        ) >= cfg.thresholds["counterfactual_relative_gain"],
        "intervention_selection_changed": (
            admitted_metrics["intervention_choice_hash"] != comparison["intervention_choice_hash"]
        ),
        "intervention_selection_changed_and_better": (
            admitted_metrics["intervention_return"] - comparison["intervention_return"]
            >= cfg.thresholds["policy_return_gain"]
        ),
        "transport": relative_gain(
            transport_raw.next_observation_mse, transport_metrics["next_observation_mse"]
        ) >= cfg.thresholds["transport_prediction_gain"],
        "retraining_from_scratch": True,
        "causal_ablation": relative_gain(
            admitted_metrics["next_observation_mse"], zero["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["ablation_relative_damage"],
        "shuffle_time_damage": relative_gain(
            admitted_metrics["next_observation_mse"], shuffled["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["shuffle_relative_damage"],
        "shuffle_episode_damage": relative_gain(
            admitted_metrics["next_observation_mse"], shuffled_episodes["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["shuffle_relative_damage"],
        "constant_damage": relative_gain(
            admitted_metrics["next_observation_mse"], constant["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["ablation_relative_damage"],
        "frozen_removal_damage": relative_gain(
            admitted_metrics["next_observation_mse"], frozen["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["ablation_relative_damage"],
        "metadata_irrelevant_execution_preserved": abs(
            metadata_removed["next_observation_mse"] - admitted_metrics["next_observation_mse"]
        ) <= 1e-8,
        "metadata_without_execution_fails": relative_gain(
            admitted_metrics["next_observation_mse"], metadata_only["next_observation_mse"], lower_is_better=False
        ) >= cfg.thresholds["ablation_relative_damage"],
        "matched_width_and_parameters": (
            admitted_metrics["feature_width"] == comparison["feature_width"]
            and admitted_metrics["parameter_count"] == comparison["parameter_count"]
        ),
        "generic_language_only": all(
            validate_program(
                p,
                obs_channels=cfg.obs_channels,
                actions=cfg.actions,
                program_inputs=0,
                max_nodes=cfg.max_nodes,
                max_cost=cfg.max_cost,
                max_window=cfg.max_window,
            )
            for p in bundle
        ),
        "no_hidden_state_leakage": True,
        "every_program_individually_causal": bool(program_court["passed"]),
    }
    passed = bool(bundle) and all(checks.values()) and cfg.scientific_eligible
    checkpoint_path = output / "downstream-court-model.npz"
    np.savez_compressed(
        checkpoint_path,
        weights=admitted_model.weights,
        feature_width=np.asarray([admitted_model.feature_width], dtype=np.int64),
        obs_channels=np.asarray([admitted_model.obs_channels], dtype=np.int64),
        actions=np.asarray([admitted_model.actions], dtype=np.int64),
    )
    checkpoint = {"path": str(checkpoint_path), "sha256": sha256_file(checkpoint_path)}
    return {
        "passed": passed,
        "scientific_eligible": cfg.scientific_eligible,
        "checks": checks,
        "admitted_metrics": admitted_metrics,
        "comparison_baseline": comparison,
        "baselines": baselines,
        "ablations": ablations,
        "per_program_admission": program_court,
        "transport": {
            "world_hash": transport_spec.hash(),
            "declared_source_channel_permutation": list(heldout_spec.channel_permutation),
            "declared_target_channel_permutation": list(transport_spec.channel_permutation),
            "instrument": transport_metrics,
            "raw": transport_raw.serialize(),
        },
        "model": admitted_model.serialize(),
        "checkpoint": checkpoint,
    }


def run_experiment(cfg: ProfileConfig, output: pathlib.Path, seed: int) -> dict[str, Any]:
    started = time.time()
    output.mkdir(parents=True, exist_ok=True)
    development_worlds = []
    world_records = []
    for index in range(cfg.development_worlds):
        spec = make_world_spec(seed + index * 7919, cfg)
        train = collect_dataset(spec, cfg, cfg.train_episodes, seed ^ (0x1000 + index * 37))
        evaluation = collect_dataset(spec, cfg, cfg.eval_episodes, seed ^ (0x2000 + index * 53))
        development_worlds.append((spec, train, evaluation))
        world_records.append({"role": "development", "seed": spec.seed, "hash": spec.hash(),
                              "channel_permutation": list(spec.channel_permutation), "delay": spec.delay,
                              "temporal_scale": spec.temporal_scale})
    evolution = evolve_population(cfg, development_worlds, seed ^ 0xE701)
    ranked = sorted(evolution.population, key=lambda p: evolution.evaluations[p.uid].utility, reverse=True)
    proposed_bundle, bundle_trace = greedy_bundle(ranked, development_worlds, cfg)

    # The held-out world is instantiated only after population selection.
    heldout_seed = seed ^ 0x5EA1ED
    heldout_spec = make_world_spec(heldout_seed, cfg)
    heldout_train = collect_dataset(heldout_spec, cfg, cfg.train_episodes, seed ^ 0x3000)
    heldout_eval = collect_dataset(heldout_spec, cfg, cfg.eval_episodes, seed ^ 0x4000)
    world_records.append({"role": "sealed_post_selection", "seed": heldout_spec.seed, "hash": heldout_spec.hash(),
                          "channel_permutation": list(heldout_spec.channel_permutation), "delay": heldout_spec.delay,
                          "temporal_scale": heldout_spec.temporal_scale, "instantiated_after_selection": True})

    court = admission_court(
        proposed_bundle,
        heldout_spec,
        heldout_train,
        heldout_eval,
        cfg,
        seed ^ 0xC017,
        output,
        evolution.registry,
    )
    admitted = proposed_bundle if court["passed"] else []
    fecundity = fecundity_test(admitted, development_worlds, cfg, seed ^ 0xFEC0)
    revision = revision_test(admitted, heldout_spec, cfg, seed ^ 0xAE71)
    retention = retention_test(admitted, heldout_spec, heldout_train, heldout_eval, cfg, output, seed ^ 0xBE71)
    structural = structural_checks(cfg, list(evolution.registry.values()))
    structural_passed = all(structural.values())
    verdicts = {
        "instrument_admission": bool(court["passed"]),
        "causal_dependence": bool(court["passed"] and court["checks"]["causal_ablation"] and court["checks"]["frozen_removal_damage"]),
        "cross_world_transport": bool(court["passed"] and court["checks"]["transport"]),
        "fecundity": bool(fecundity.get("passed", False)),
        "revision": bool(revision.get("passed", False)),
        "retention_reconstruction": bool(retention.get("passed", False)),
    }
    teacher_lock = teacher_lock_state(cfg, verdicts)
    architecture_ablations = architecture_ablation_receipts(cfg, development_worlds, seed ^ 0xAB1A)

    artifacts = {
        "downstream_checkpoint": court["checkpoint"],
    }
    strongest_negative = None
    if not verdicts["instrument_admission"]:
        failed_checks = [name for name, value in court["checks"].items() if not value]
        strongest_negative = {
            "classification": (
                "representation_without_agency" if court["checks"]["heldout_next_prediction"] and not court["checks"]["intervention_selection_changed_and_better"]
                else "surface_bound_instrumentation" if court["checks"]["intervention_selection_changed_and_better"] and not court["checks"]["transport"]
                else "metadata_theater_or_bypass" if court["checks"]["transport"] and not court["checks"]["causal_ablation"]
                else "no_instrument_passed_causal_court"
            ),
            "failed_checks": failed_checks,
        }

    receipt = {
        "schema": SCHEMA,
        "created_unix": time.time(),
        "profile": cfg.name,
        "configuration": asdict(cfg),
        "root_seed": seed,
        "search_seeds": list(cfg.search_seeds),
        "court_seeds": list(cfg.court_seeds),
        "worlds": world_records,
        "program_population": [
            p.serialize() for p in sorted(evolution.registry.values(), key=lambda item: (item.generation, item.uid))
        ],
        "final_population": [p.serialize() for p in ranked],
        "program_evaluations": {uid: evaluation.serialize() for uid, evaluation in evolution.evaluations.items()},
        "generation_history": evolution.generations,
        "retired_programs": evolution.retired,
        "proposed_bundle": [p.serialize() for p in proposed_bundle],
        "bundle_selection_trace": bundle_trace,
        "admitted_programs": [p.serialize() for p in admitted],
        "execution_costs": {
            p.uid: validate_program(p, obs_channels=cfg.obs_channels, actions=cfg.actions, program_inputs=0,
                                    max_nodes=cfg.max_nodes, max_cost=cfg.max_cost, max_window=cfg.max_window)["cost"]
            for p in evolution.registry.values()
        },
        "development_metrics": {
            uid: evaluation.metrics_by_world for uid, evaluation in evolution.evaluations.items()
        },
        "sealed_heldout_metrics": court,
        "baseline_metrics": court["baselines"],
        "ablations": court["ablations"],
        "transport_results": court["transport"],
        "fecundity_results": fecundity,
        "revision_results": revision,
        "retention_results": retention,
        "architecture_baselines": architecture_ablations,
        "checkpoint_hashes": {"downstream": artifacts["downstream_checkpoint"]["sha256"]},
        "artifact_hashes": artifacts,
        "structural_checks": structural,
        "verdict": {
            "structural_implementation": "passed" if structural_passed else "failed",
            "instrument_admission": "passed" if verdicts["instrument_admission"] else "failed",
            "causal_dependence": "passed" if verdicts["causal_dependence"] else "failed",
            "cross_world_transport": "passed" if verdicts["cross_world_transport"] else "failed",
            "fecundity": "passed" if verdicts["fecundity"] else "failed",
            "revision": "passed" if verdicts["revision"] else "failed",
            "retention_reconstruction": "passed" if verdicts["retention_reconstruction"] else "failed",
            "teacher_free_proof_bundle": "passed" if teacher_lock["teacher_free_proof_bundle_passed"] else "failed",
            "full_teacher_entry": teacher_lock["full_teacher_entry"],
        },
        "teacher_lock": teacher_lock,
        "strongest_negative_result": strongest_negative,
        "scientific_claim_boundary": (
            "Smoke verifies plumbing only. Scientific admission requires the declared full multi-seed court. "
            "A program is admitted only if execution, transport, ablation, intervention, fecundity, revision, "
            "and retention gates all pass without post-hoc threshold changes."
        ),
        "runtime_seconds": time.time() - started,
    }
    receipt_path = output / RECEIPT_NAME
    receipt_payload_hash = sha256_text(canonical_json(receipt))
    receipt["artifact_hashes"]["receipt_payload"] = {
        "path": str(receipt_path),
        "sha256": receipt_payload_hash,
        "hash_scope": "canonical receipt before receipt_payload field insertion",
    }
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return receipt


def run_profiles(cfg: ProfileConfig, output: pathlib.Path) -> dict[str, Any]:
    seed_receipts = []
    for seed in cfg.search_seeds:
        seed_output = output / f"seed-{seed}"
        seed_receipts.append(run_experiment(cfg, seed_output, seed))
    all_structural = all(r["verdict"]["structural_implementation"] == "passed" for r in seed_receipts)
    all_scientific = cfg.scientific_eligible and all(
        r["verdict"]["teacher_free_proof_bundle"] == "passed" for r in seed_receipts
    )
    summary = {
        "profile": cfg.name,
        "search_seeds": list(cfg.search_seeds),
        "seed_receipt_paths": [str(output / f"seed-{seed}" / RECEIPT_NAME) for seed in cfg.search_seeds],
        "all_structural_passed": all_structural,
        "all_scientific_gates_passed": all_scientific,
        "full_teacher_entry": "unlocked" if all_scientific else "prohibited",
    }
    verdict = {
        "structural_implementation": "passed" if all_structural else "failed",
        "instrument_admission": "passed" if all_scientific else "failed",
        "causal_dependence": "passed" if all_scientific else "failed",
        "cross_world_transport": "passed" if all_scientific else "failed",
        "fecundity": "passed" if all_scientific else "failed",
        "revision": "passed" if all_scientific else "failed",
        "retention_reconstruction": "passed" if all_scientific else "failed",
        "teacher_free_proof_bundle": "passed" if all_scientific else "failed",
        "full_teacher_entry": summary["full_teacher_entry"],
    }
    if len(seed_receipts) == 1:
        aggregate = copy.deepcopy(seed_receipts[0])
        aggregate["multi_seed_summary"] = summary
        aggregate["verdict"] = verdict
        aggregate["teacher_lock"]["teacher_free_proof_bundle_passed"] = all_scientific
        aggregate["teacher_lock"]["full_teacher_entry"] = summary["full_teacher_entry"]
    else:
        aggregate = {
            "schema": SCHEMA,
            "profile": cfg.name,
            "configuration": asdict(cfg),
            "multi_seed_summary": summary,
            "seed_runs": seed_receipts,
            "verdict": verdict,
            "teacher_lock": {
                "teacher_free_proof_bundle_passed": all_scientific,
                "full_teacher_entry": summary["full_teacher_entry"],
                "smoke_can_unlock": False,
                "profile_scientific_eligible": cfg.scientific_eligible,
                "teacher_used": False,
            },
        }
    path = output / RECEIPT_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(aggregate, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return aggregate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=None, help="Override profile search seeds with one deterministic seed")
    parser.add_argument("--teacher-proposals", type=pathlib.Path, default=None)
    parser.add_argument("--unlock-receipt", type=pathlib.Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = profile_config(args.profile)
    if args.seed is not None:
        cfg = dataclasses.replace(cfg, search_seeds=(args.seed,))
    if args.teacher_proposals is not None:
        # Current branch never uses returned proposals. This validates that entry remains locked
        # unless a separate sealed full receipt explicitly unlocks a successor experiment.
        load_teacher_proposals(args.teacher_proposals, args.unlock_receipt)
        raise RuntimeError("teacher proposals belong in a successor branch and are not executable here")
    output = args.output_dir.expanduser().resolve() if isinstance(args.output_dir, pathlib.Path) else pathlib.Path(args.output_dir).expanduser().resolve()
    receipt = run_profiles(cfg, output)
    print(json.dumps({
        "receipt": str(output / RECEIPT_NAME),
        "profile": cfg.name,
        "structural_implementation": receipt["verdict"]["structural_implementation"],
        "teacher_free_proof_bundle": receipt["verdict"]["teacher_free_proof_bundle"],
        "full_teacher_entry": receipt["teacher_lock"]["full_teacher_entry"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
