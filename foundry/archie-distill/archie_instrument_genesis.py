#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
from dataclasses import asdict
from typing import Any

from archie_instrument_core import *
from archie_instrument_metrics import *


def search_seed(cfg: Config, seed: int, output: pathlib.Path) -> dict[str, Any]:
    rng = random.Random(seed)
    train_worlds = build_worlds(cfg, seed, cfg.train_worlds_per_family, 1000)
    validation_worlds = build_worlds(cfg, seed, cfg.validation_worlds_per_family, 2000000)
    admission_worlds = build_worlds(cfg, seed, cfg.admission_worlds_per_family, 4000000)
    sealed_worlds = build_worlds(cfg, seed, cfg.sealed_worlds_per_family, 6000000)
    train = make_dataset(cfg, train_worlds, cfg.train_contexts, seed + 11)
    validation = make_dataset(cfg, validation_worlds, cfg.eval_contexts, seed + 23)
    admission = make_dataset(cfg, admission_worlds, cfg.eval_contexts, seed + 37)
    sealed = make_dataset(cfg, sealed_worlds, cfg.eval_contexts, seed + 53)

    seeded = seed_programs()
    population: list[Individual] = [
        Individual(program, (), 0, "generic_basis") for program in seeded[: cfg.population]
    ]
    while len(population) < cfg.population:
        population.append(Individual(random_program(rng, cfg.max_depth), (), 0, "genesis"))
    archive: list[Individual] = []
    retired: list[dict[str, Any]] = []
    trials: list[dict[str, Any]] = []
    seen: set[str] = set()

    for generation in range(cfg.generations):
        unique: list[Individual] = []
        for item in population:
            pid = item.program.program_id
            if pid not in seen and item.program.complexity <= 40:
                seen.add(pid)
                unique.append(item)
        if not unique:
            unique = [Individual(random_program(rng, cfg.max_depth), (), generation, "restart")]
        active_by_id = {item.program.program_id: item for item in archive}
        for item in unique:
            full_programs = [x.program for x in archive]
            additive = candidate_report(train, validation, full_programs, item.program, cfg)
            additive["mode"] = "additive"
            additive["replaced_parent_ids"] = []
            options = [additive]
            parent_ids = [pid for pid in item.parents if pid in active_by_id]
            if parent_ids and all(contains_program(item.program, active_by_id[pid].program) for pid in parent_ids):
                replacement_base = [x.program for x in archive if x.program.program_id not in parent_ids]
                replacement = candidate_report(train, validation, replacement_base, item.program, cfg)
                current = metrics(train, validation, full_programs, cfg)
                proposed = metrics(train, validation, replacement_base + [item.program], cfg)
                replacement_delta = gains(current, proposed)
                replacement["score"] += replacement_delta["prediction_gain"] + 0.8 * replacement_delta["policy_gain"]
                replacement["mode"] = "replacement"
                replacement["replaced_parent_ids"] = parent_ids
                replacement["lineage_delta"] = replacement_delta
                options.append(replacement)
            item.validation = max(options, key=lambda row: row["score"])
            item.score = item.validation["score"]
        unique.sort(key=lambda item: item.score, reverse=True)
        elites = unique[: cfg.elites]

        for item in elites[:4]:
            if len(archive) >= cfg.max_active:
                break
            if item.validation is None:
                continue
            if item.validation["prediction_gain"] <= cfg.prediction_gate * 0.7:
                continue
            mode = str(item.validation.get("mode", "additive"))
            replaced_parent_ids = list(item.validation.get("replaced_parent_ids", []))
            base_archive = [x for x in archive if x.program.program_id not in replaced_parent_ids] if mode == "replacement" else list(archive)
            report = admission_report(train, admission, [x.program for x in base_archive], item.program, cfg, seed + generation)
            if mode == "replacement":
                current = metrics(train, admission, [x.program for x in archive], cfg)
                proposed = metrics(train, admission, [x.program for x in base_archive] + [item.program], cfg)
                delta = gains(current, proposed)
                report["lineage_delta"] = delta
                report["checks"]["descendant_improves_lineage"] = (
                    (delta["prediction_gain"] > 0.003 or delta["policy_gain"] > 0.003)
                    and delta["prediction_gain"] > -0.01
                    and delta["policy_gain"] > -0.01
                )
                report["admitted"] = all(report["checks"].values())
            trials.append({
                "generation": generation,
                "program_id": item.program.program_id,
                "program": item.program.to_json(),
                "parents": list(item.parents),
                "origin": item.origin,
                "mode": mode,
                "validation": item.validation,
                "admission": report,
            })
            if report["admitted"]:
                if mode == "replacement":
                    for parent_id in replaced_parent_ids:
                        retired.append({
                            "program_id": parent_id,
                            "reason": "superseded_by_admitted_descendant",
                            "descendant": item.program.program_id,
                            "lineage_delta": report.get("lineage_delta", {}),
                        })
                    archive = base_archive
                archive.append(item)
                archive, newly_retired = retire_redundant(train, admission, archive, cfg)
                retired.extend(newly_retired)
                break

        next_population: list[Individual] = []
        next_population.extend(elites)
        if archive:
            for _ in range(max(4, cfg.population // 5)):
                parent = rng.choice(archive)
                next_population.append(Individual(
                    descend(parent.program, rng, cfg.max_depth),
                    (parent.program.program_id,), generation + 1, "archive_mutation"
                ))
            if len(archive) >= 2:
                for _ in range(max(3, cfg.population // 8)):
                    left, right = rng.sample(archive, 2)
                    next_population.append(Individual(
                        compose(left.program, right.program, rng),
                        (left.program.program_id, right.program.program_id), generation + 1, "archive_composition"
                    ))
        while len(next_population) < cfg.population:
            if elites and rng.random() < 0.75:
                parent = rng.choice(elites)
                next_population.append(Individual(
                    mutate(parent.program, rng, cfg.max_depth),
                    (parent.program.program_id,), generation + 1, "population_mutation"
                ))
            else:
                next_population.append(Individual(random_program(rng, cfg.max_depth), (), generation + 1, "spontaneous"))
        population = next_population[: cfg.population]

    programs = [item.program for item in archive]
    sealed_base = metrics(train, sealed, [], cfg)
    sealed_augmented = metrics(train, sealed, programs, cfg)
    sealed_ablated = metrics(train, sealed, programs, cfg, permute_all=True, seed=seed ^ 0xAB1A)
    sealed_gain = gains(sealed_base, sealed_augmented)
    sealed_ablation = gains(sealed_augmented, sealed_ablated)
    base_family = family_metrics(train, sealed, [], cfg)
    aug_family = family_metrics(train, sealed, programs, cfg)
    sealed_family_gain = {family: gains(base_family[family], aug_family[family]) for family in base_family}
    has_descendant = any(bool(item.parents) for item in archive)
    checks = {
        "instrument_admitted": bool(programs),
        "sealed_prediction_gain": sealed_gain["prediction_gain"] > cfg.prediction_gate,
        "sealed_intervention_gain": sealed_gain["policy_gain"] > cfg.policy_gate,
        "sealed_causal_ablation": sealed_ablation["policy_gain"] < -cfg.ablation_gate,
        "all_world_families_intervention_gain": all(row["policy_gain"] > 0 for row in sealed_family_gain.values()),
        "family_prediction_not_catastrophic": all(row["prediction_gain"] > -0.05 for row in sealed_family_gain.values()),
        "second_generation_admitted": has_descendant,
        "generic_language_only": all(validate_language(program) for program in programs),
    }
    passed = all(checks.values())
    evidence_fraction = sum(checks.values()) / len(checks)
    larp_scale = round(1.0 - evidence_fraction, 4)

    pack = {
        "schema": "archie-instrument-pack/v1",
        "seed": seed,
        "programs": [
            {
                "program_id": item.program.program_id,
                "program": item.program.to_json(),
                "parents": list(item.parents),
                "generation": item.generation,
                "origin": item.origin,
            }
            for item in archive
        ],
        "runtime_contract": {
            "input": "generic primitive scalar map from raw history and candidate intervention",
            "output": "counterfactual consequence estimate and intervention score",
            "metadata_available_to_controller": False,
        },
        "runtime": fit_runtime(train, programs, cfg),
    }
    pack_path = output / f"instrument-pack-{seed}.json"
    pack_path.write_text(json.dumps(pack, indent=2, sort_keys=True) + "\n")
    return {
        "seed": seed,
        "active_instruments": pack["programs"],
        "retired": retired,
        "trials": trials,
        "sealed": {
            "base": sealed_base,
            "augmented": sealed_augmented,
            "ablated": sealed_ablated,
            "gain": sealed_gain,
            "ablation_effect": sealed_ablation,
            "family_gain": sealed_family_gain,
        },
        "checks": checks,
        "passed": passed,
        "larp_scale": larp_scale,
        "pack_path": str(pack_path),
        "pack_sha256": hashlib.sha256(pack_path.read_bytes()).hexdigest(),
    }


def aggregate(cfg: Config, runs: list[dict[str, Any]]) -> dict[str, Any]:
    passed = all(run["passed"] for run in runs)
    max_larp = max(run["larp_scale"] for run in runs)
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "runs": runs,
        "passed_architecture_gate": passed,
        "full_teacher_entry": "unlocked" if passed and cfg.profile == "full" else "prohibited",
        "larp_scale": max_larp,
        "disposition": (
            "executable-instrument-genesis-evidence" if passed
            else "instrument-genesis-not-established"
        ),
        "claim_boundary": (
            "Pass means generic executable measurement programs were evolved, admitted only through "
            "held-out cross-world counterfactual prediction and intervention, and shown causally necessary "
            "for the downstream controller. It does not establish open-ended concept formation or AGI."
        ),
    }


def profile(name: str) -> Config:
    if name == "smoke":
        return Config(profile=name)
    if name == "full":
        return Config(
            train_worlds_per_family=5,
            validation_worlds_per_family=2,
            admission_worlds_per_family=2,
            sealed_worlds_per_family=3,
            train_contexts=256,
            eval_contexts=256,
            population=160,
            generations=55,
            elites=24,
            max_active=8,
            prediction_gate=0.01,
            policy_gate=0.008,
            ablation_gate=0.004,
            seeds=(17, 29, 43),
            profile=name,
        )
    raise ValueError(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    cfg = profile(args.profile)
    output = pathlib.Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    runs = [search_seed(cfg, seed, output) for seed in cfg.seeds]
    receipt = aggregate(cfg, runs)
    receipt_path = output / "instrument-genesis.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
