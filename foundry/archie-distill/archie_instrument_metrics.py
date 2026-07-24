#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
from dataclasses import asdict
from typing import Any, Iterable

import numpy as np

from archie_instrument_core import *


def standardize(train: np.ndarray, other: Iterable[np.ndarray]) -> tuple[np.ndarray, list[np.ndarray], np.ndarray, np.ndarray]:
    mean = train.mean(axis=0, keepdims=True)
    std = train.std(axis=0, keepdims=True)
    std[std < 1e-8] = 1.0
    return (train - mean) / std, [(x - mean) / std for x in other], mean, std


def fit_ridge(train_x: np.ndarray, train_y: np.ndarray, ridge: float) -> np.ndarray:
    eye = np.eye(train_x.shape[1])
    return np.linalg.solve(train_x.T @ train_x + ridge * eye, train_x.T @ train_y)


def design(dataset: Dataset, programs: list[Program]) -> np.ndarray:
    columns = [dataset.base]
    if programs:
        columns.append(np.stack([evaluate_program(p, dataset.primitive) for p in programs], axis=1))
    return np.concatenate(columns, axis=1)


def grouped_policy_cost(prediction: np.ndarray, dataset: Dataset) -> float:
    costs = []
    for group_id in np.unique(dataset.group):
        mask = dataset.group == group_id
        local_pred = prediction[mask]
        local_target = dataset.target[mask]
        costs.append(float(local_target[int(np.argmin(local_pred))]))
    return float(np.mean(costs))


def metrics(train: Dataset, evaluation: Dataset, programs: list[Program], cfg: Config,
            ablate_last: bool = False, permute_all: bool = False, seed: int = 0) -> dict[str, float]:
    train_x = design(train, programs)
    eval_x = design(evaluation, programs)
    train_x, [eval_x], _, _ = standardize(train_x, [eval_x])
    coef = fit_ridge(train_x, train.target, cfg.ridge)
    centered_target = train.target.copy()
    for group_id in np.unique(train.group):
        mask = train.group == group_id
        centered_target[mask] -= centered_target[mask].mean()
    policy_coef = fit_ridge(train_x, centered_target, cfg.ridge)
    if programs and ablate_last:
        eval_x[:, -1] = 0.0
    if programs and permute_all:
        rng = np.random.default_rng(seed)
        instrument_start = train.base.shape[1]
        for column in range(instrument_start, eval_x.shape[1]):
            eval_x[:, column] = rng.permutation(eval_x[:, column])
    prediction = eval_x @ coef
    policy_prediction = eval_x @ policy_coef
    mse = float(np.mean((prediction - evaluation.target) ** 2))
    policy = grouped_policy_cost(policy_prediction, evaluation)
    return {"mse": mse, "policy_cost": policy}


def family_metrics(train: Dataset, evaluation: Dataset, programs: list[Program], cfg: Config) -> dict[str, dict[str, float]]:
    result = {}
    for family in sorted(set(evaluation.family.tolist())):
        mask = evaluation.family == family
        subset = Dataset(
            primitive={k: v[mask] for k, v in evaluation.primitive.items()},
            base=evaluation.base[mask], target=evaluation.target[mask],
            group=evaluation.group[mask], family=evaluation.family[mask],
            action_index=evaluation.action_index[mask],
        )
        result[str(family)] = metrics(train, subset, programs, cfg)
    return result


def gains(base: dict[str, float], augmented: dict[str, float]) -> dict[str, float]:
    return {
        "prediction_gain": (base["mse"] - augmented["mse"]) / max(base["mse"], 1e-12),
        "policy_gain": (base["policy_cost"] - augmented["policy_cost"]) / max(base["policy_cost"], 1e-12),
    }


def validate_language(program: Program) -> bool:
    text = stable_json(program.to_json()).lower()
    return not any(word in text for word in FORBIDDEN_WORDS)


def candidate_report(train: Dataset, validation: Dataset, archive: list[Program], candidate: Program, cfg: Config) -> dict[str, float]:
    base = metrics(train, validation, archive, cfg)
    augmented = metrics(train, validation, archive + [candidate], cfg)
    report = {**gains(base, augmented), "mse": augmented["mse"], "policy_cost": augmented["policy_cost"]}
    report["variance"] = float(np.var(evaluate_program(candidate, validation.primitive)))
    report["score"] = (
        report["prediction_gain"] + 0.8 * report["policy_gain"]
        - 0.0008 * candidate.complexity
    )
    return report


def admission_report(train: Dataset, admission: Dataset, archive: list[Program], candidate: Program, cfg: Config, seed: int) -> dict[str, Any]:
    base = metrics(train, admission, archive, cfg)
    augmented = metrics(train, admission, archive + [candidate], cfg)
    ablated = metrics(train, admission, archive + [candidate], cfg, ablate_last=True, seed=seed)
    overall = gains(base, augmented)
    ablation = gains(augmented, ablated)
    base_family = family_metrics(train, admission, archive, cfg)
    aug_family = family_metrics(train, admission, archive + [candidate], cfg)
    family_gain = {
        family: gains(base_family[family], aug_family[family]) for family in base_family
    }
    checks = {
        "language_is_generic": validate_language(candidate),
        "feature_is_nondegenerate": float(np.var(evaluate_program(candidate, admission.primitive))) > 1e-5,
        "prediction_improves": overall["prediction_gain"] > cfg.prediction_gate,
        "intervention_improves": overall["policy_gain"] > cfg.policy_gate,
        "causal_ablation_removes_gain": ablation["policy_gain"] < -cfg.ablation_gate,
        "cross_family_prediction": all(row["prediction_gain"] > 0.0 for row in family_gain.values()),
    }
    return {
        "base": base,
        "augmented": augmented,
        "ablated": ablated,
        "overall_gain": overall,
        "ablation_effect": ablation,
        "family_gain": family_gain,
        "checks": checks,
        "admitted": all(checks.values()),
    }


def build_worlds(cfg: Config, seed: int, count_per_family: int, offset: int) -> list[RawWorld]:
    return [
        RawWorld(family, seed + offset + family * 100000 + index * 7919, cfg)
        for family in range(3)
        for index in range(count_per_family)
    ]


def retire_redundant(train: Dataset, admission: Dataset, archive: list[Individual], cfg: Config) -> tuple[list[Individual], list[dict[str, Any]]]:
    if len(archive) < 2:
        return archive, []
    full_programs = [item.program for item in archive]
    full = metrics(train, admission, full_programs, cfg)
    retired = []
    survivors = []
    for index, item in enumerate(archive):
        without = metrics(train, admission, [p for j, p in enumerate(full_programs) if j != index], cfg)
        marginal = gains(without, full)
        if marginal["prediction_gain"] < -0.002 and marginal["policy_gain"] < -0.002:
            retired.append({"program_id": item.program.program_id, "reason": "negative_joint_marginal", "marginal": marginal})
        else:
            survivors.append(item)
    return survivors or archive, retired


def fit_runtime(train: Dataset, programs: list[Program], cfg: Config) -> dict[str, Any]:
    matrix = design(train, programs)
    mean = matrix.mean(axis=0, keepdims=True)
    std = matrix.std(axis=0, keepdims=True)
    std[std < 1e-8] = 1.0
    normalized = (matrix - mean) / std
    centered_target = train.target.copy()
    for group_id in np.unique(train.group):
        mask = train.group == group_id
        centered_target[mask] -= centered_target[mask].mean()
    return {
        "base_names": list(BASE_NAMES),
        "primitive_names": list(PRIMITIVE_NAMES),
        "feature_mean": mean.reshape(-1).tolist(),
        "feature_std": std.reshape(-1).tolist(),
        "counterfactual_coefficients": fit_ridge(normalized, train.target, cfg.ridge).tolist(),
        "intervention_coefficients": fit_ridge(normalized, centered_target, cfg.ridge).tolist(),
    }
