#!/usr/bin/env python3
"""Run matched-resource Archie ablations and replicate the strongest pilots."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import shutil
import subprocess
import sys
import time
from typing import Any

from archie_hybrid_corpus import atomic_json, sha256_file, stable_json

SCHEMA = "archie-hybrid-research-campaign/v1"


def default_candidates() -> list[dict[str, Any]]:
    return [
        {
            "id": "baseline-hybrid-governed-byte",
            "role": "baseline",
            "hypothesis": "Selective SSM plus periodic local attention is the strongest geometry-matched mixer.",
            "corpus": "governed_byte",
            "mixer_mode": "hybrid",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "comparator-attention-governed-byte",
            "role": "architecture",
            "hypothesis": "A geometry-matched local-attention stack is stronger than the hybrid.",
            "corpus": "governed_byte",
            "mixer_mode": "attention",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "comparator-ssm-governed-byte",
            "role": "architecture",
            "hypothesis": "A geometry-matched selective-state stack is stronger than the hybrid.",
            "corpus": "governed_byte",
            "mixer_mode": "ssm",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "ablation-hybrid-raw-all-byte",
            "role": "corpus",
            "hypothesis": "Unwrapped raw source training matches the governed task curriculum.",
            "corpus": "raw_all_byte",
            "evaluation_corpus": "governed_byte",
            "mixer_mode": "hybrid",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "comparator-hybrid-raw-code-byte",
            "role": "corpus",
            "hypothesis": "Ordinary raw source-code training matches the governed curriculum.",
            "corpus": "raw_code_byte",
            "evaluation_corpus": "governed_byte",
            "mixer_mode": "hybrid",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "candidate-hybrid-governed-pairgram",
            "role": "tokenizer",
            "hypothesis": "Learned reversible byte pairs improve capability per wall-clock minute.",
            "corpus": "governed_pairgram",
            "mixer_mode": "hybrid",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "candidate-plastic-hybrid-governed-byte",
            "role": "plasticity",
            "hypothesis": "Learned delta-rule fast weights improve transfer per wall-clock minute.",
            "corpus": "governed_byte",
            "mixer_mode": "hybrid",
            "plastic_mode": "delta",
            "loss_normalization": "byte",
            "gradient_checkpointing": True,
        },
        {
            "id": "systems-hybrid-no-checkpoint",
            "role": "systems",
            "hypothesis": "Recomputation costs more throughput than it saves useful batch capacity.",
            "corpus": "governed_byte",
            "mixer_mode": "hybrid",
            "loss_normalization": "byte",
            "gradient_checkpointing": False,
        },
    ]


def validate_candidate(candidate: dict[str, Any]) -> None:
    required = {"id", "role", "hypothesis", "corpus", "mixer_mode"}
    missing = sorted(required - candidate.keys())
    if missing:
        raise ValueError(f"candidate is missing fields: {missing}")
    if candidate["mixer_mode"] not in {"hybrid", "attention", "ssm"}:
        raise ValueError(f"unsupported mixer mode in {candidate['id']}")
    if candidate.get("loss_normalization", "byte") not in {"byte", "token"}:
        raise ValueError(f"unsupported loss normalization in {candidate['id']}")
    if candidate.get("plastic_mode", "none") not in {"none", "delta"}:
        raise ValueError(f"unsupported plastic mode in {candidate['id']}")


def run_candidate(
    args: argparse.Namespace, candidate: dict[str, Any], seed: int, phase: str,
    corpora: dict[str, pathlib.Path],
) -> dict[str, Any]:
    candidate_id = candidate["id"]
    output = pathlib.Path(args.state_dir).resolve() / phase / candidate_id
    receipt_path = output / "run" / "training-receipt.json"
    execution = "trained"
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        execution = "reused"
    else:
        corpus_name = candidate["corpus"]
        evaluation_name = candidate.get("evaluation_corpus", corpus_name)
        if corpus_name not in corpora or evaluation_name not in corpora:
            raise ValueError(f"candidate {candidate_id} names an unknown corpus")
        output.mkdir(parents=True, exist_ok=True)
        command = [
            args.python, args.trainer,
            "--corpus", str(corpora[corpus_name] / "train.u16"),
            "--eval-corpus", str(corpora[evaluation_name] / "development.u16"),
            "--state-dir", str(output), "--preset", args.preset, "--device", args.device,
            "--seq-len", str(args.sequence_length), "--batch-size", str(args.batch_size),
            "--eval-batch-size", str(args.eval_batch_size), "--grad-accum", "1",
            "--max-steps", str(args.max_steps),
            "--learning-rate", str(candidate.get("learning_rate", args.learning_rate)),
            "--min-lr-ratio", "1.0", "--warmup-steps", str(args.warmup_steps),
            "--weight-decay", str(args.weight_decay), "--grad-clip", "1.0",
            "--max-consecutive-skips", "4", "--save-every", str(args.save_every),
            "--eval-every", str(args.eval_every), "--eval-batches", str(args.eval_batches),
            "--log-every", str(args.log_every), "--generate-tokens", "24",
            "--deadline-minutes", str(args.candidate_minutes), "--deadline-buffer-seconds", "2",
            "--seed", str(seed), "--amp-dtype", candidate.get("amp_dtype", args.amp_dtype),
            "--mixer-mode", candidate["mixer_mode"],
            "--plastic-mode", candidate.get("plastic_mode", "none"),
            "--plastic-rank", str(candidate.get("plastic_rank", 16)),
            "--loss-normalization", candidate.get("loss_normalization", "byte"),
            "--gradient-checkpointing" if candidate.get("gradient_checkpointing", True)
            else "--no-gradient-checkpointing",
            "--compile" if candidate.get("compile", False) else "--no-compile",
            "--tf32" if candidate.get("tf32", True) else "--no-tf32",
        ]
        (output / "command.json").write_text(
            json.dumps(command, indent=2) + "\n", encoding="utf-8"
        )
        started = time.monotonic()
        with (output / "training.log").open("w", encoding="utf-8") as log:
            completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, text=True)
        if completed.returncode or not receipt_path.exists():
            return {
                "id": candidate_id, "role": candidate["role"], "phase": phase, "seed": seed,
                "status": "failed", "returncode": completed.returncode,
                "seconds": time.monotonic() - started, "log": str(output / "training.log"),
                "hypothesis": candidate["hypothesis"],
            }
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    transfer = None
    if candidate.get("plastic_mode", "none") == "delta" and args.plastic_suite:
        transfer_path = output / "run" / "plastic-transfer-receipt.json"
        if not transfer_path.exists():
            transfer_command = [
                args.python, str(pathlib.Path(__file__).with_name("evaluate_plastic_transfer.py")),
                "--model", str(output / "run" / "model.pt"),
                "--suite", args.plastic_suite, "--output", str(transfer_path),
                "--device", args.device, "--minimum-effect", str(args.minimum_effect),
            ]
            with (output / "plastic-transfer.log").open("w", encoding="utf-8") as log:
                completed = subprocess.run(
                    transfer_command, stdout=log, stderr=subprocess.STDOUT, text=True
                )
            if completed.returncode or not transfer_path.exists():
                return {
                    "id": candidate_id, "role": candidate["role"], "phase": phase,
                    "seed": seed, "status": "failed-plastic-transfer",
                    "returncode": completed.returncode,
                    "log": str(output / "plastic-transfer.log"),
                    "hypothesis": candidate["hypothesis"],
                }
        transfer = json.loads(transfer_path.read_text(encoding="utf-8"))
    return summarize(candidate, seed, phase, receipt, execution, transfer)


def summarize(
    candidate: dict[str, Any], seed: int, phase: str,
    receipt: dict[str, Any], execution: str,
    plastic_transfer: dict[str, Any] | None = None,
) -> dict[str, Any]:
    optimization = receipt["optimization"]
    runtime = receipt["runtime"]
    return {
        "id": candidate["id"], "role": candidate["role"], "phase": phase, "seed": seed,
        "status": "ok", "execution": execution, "hypothesis": candidate["hypothesis"],
        "mixer_mode": candidate["mixer_mode"], "corpus": candidate["corpus"],
        "plastic_mode": candidate.get("plastic_mode", "none"),
        "evaluation_corpus": candidate.get("evaluation_corpus", candidate["corpus"]),
        "tokenizer_schema": receipt["tokenizer"]["schema"],
        "parameters": receipt["model"]["parameters"],
        "steps": optimization["step"], "tokens_seen": optimization["tokens_seen"],
        "bytes_seen": optimization["bytes_seen"],
        "final_eval_bits_per_byte": optimization["final_eval_bits_per_byte"],
        "best_eval_bits_per_byte": optimization["best_eval_bits_per_byte"],
        "skipped_nonfinite_steps": optimization["skipped_nonfinite_steps"],
        "seconds": runtime["seconds"], "tokens_per_second": runtime["tokens_per_second"],
        "bytes_per_second": runtime["bytes_per_second"],
        "peak_allocated_mib": runtime["peak_allocated_mib"],
        "receipt_digest": receipt["receipt_digest"],
        "model_sha256": receipt["model"]["export_sha256"],
        "plastic_transfer": plastic_transfer,
    }


def successful(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        result for result in results
        if result["status"] == "ok" and result["skipped_nonfinite_steps"] == 0
        and result["steps"] > 0
        and math.isfinite(result["final_eval_bits_per_byte"])
    ]


def by_id(results: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {result["id"]: result for result in successful(results)}


def improvement(reference: dict[str, Any], candidate: dict[str, Any]) -> float:
    return (
        reference["final_eval_bits_per_byte"] - candidate["final_eval_bits_per_byte"]
    ) / reference["final_eval_bits_per_byte"]


def campaign_contract(
    args: argparse.Namespace, candidates: list[dict[str, Any]],
    corpora: dict[str, pathlib.Path],
) -> dict[str, Any]:
    implementation_files = [
        pathlib.Path(__file__).resolve(),
        pathlib.Path(__file__).with_name("archie_hybrid_core.py"),
        pathlib.Path(__file__).with_name("archie_hybrid_corpus.py"),
        pathlib.Path(__file__).with_name("archie_tokenizers.py"),
        pathlib.Path(__file__).with_name("train_archie_hybrid.py"),
        pathlib.Path(__file__).with_name("evaluate_plastic_transfer.py"),
    ]
    implementation = {
        str(path.name): sha256_file(path) for path in implementation_files
    }
    contract = {
        "schema": "archie-hybrid-research-contract/v1",
        "candidates": candidates,
        "corpora": {
            name: sha256_file(root / "manifest.json") for name, root in sorted(corpora.items())
        },
        "implementation": implementation,
        "resources": {
            "preset": args.preset, "device": args.device,
            "sequence_length": args.sequence_length, "batch_size": args.batch_size,
            "eval_batch_size": args.eval_batch_size,
            "candidate_minutes": args.candidate_minutes, "max_steps": args.max_steps,
            "learning_rate": args.learning_rate, "warmup_steps": args.warmup_steps,
            "weight_decay": args.weight_decay, "amp_dtype": args.amp_dtype,
            "save_every": args.save_every, "eval_every": args.eval_every,
            "eval_batches": args.eval_batches, "seed": args.seed,
            "replication_seed": args.replication_seed,
            "replicate_top": args.replicate_top, "minimum_effect": args.minimum_effect,
            "plastic_suite_sha256": (
                sha256_file(pathlib.Path(args.plastic_suite).resolve())
                if args.plastic_suite else None
            ),
        },
    }
    contract["contract_digest"] = hashlib.sha256(stable_json(contract).encode()).hexdigest()
    return contract


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--governed-byte", required=True)
    parser.add_argument("--raw-byte", required=True)
    parser.add_argument("--raw-code-byte", required=True)
    parser.add_argument("--governed-pairgram", required=True)
    parser.add_argument("--campaign-json")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--trainer", default=str(pathlib.Path(__file__).with_name("train_archie_hybrid.py")))
    parser.add_argument("--preset", default="tiny")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--sequence-length", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--eval-batch-size", type=int, default=8)
    parser.add_argument("--candidate-minutes", type=float, default=8)
    parser.add_argument("--max-steps", type=int, default=100_000)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--warmup-steps", type=int, default=20)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--amp-dtype", default="float16")
    parser.add_argument("--save-every", type=int, default=50)
    parser.add_argument("--eval-every", type=int, default=50)
    parser.add_argument("--eval-batches", type=int, default=8)
    parser.add_argument("--log-every", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260724)
    parser.add_argument("--replication-seed", type=int, default=20260725)
    parser.add_argument("--replicate-top", type=int, default=2)
    parser.add_argument("--minimum-effect", type=float, default=0.03)
    parser.add_argument("--plastic-suite")
    args = parser.parse_args()

    corpora = {
        "governed_byte": pathlib.Path(args.governed_byte).resolve(),
        "raw_all_byte": pathlib.Path(args.raw_byte).resolve(),
        "raw_code_byte": pathlib.Path(args.raw_code_byte).resolve(),
        "governed_pairgram": pathlib.Path(args.governed_pairgram).resolve(),
    }
    for name, root in corpora.items():
        for filename in ("train.u16", "development.u16", "manifest.json"):
            if not (root / filename).exists():
                raise SystemExit(f"{name} is missing {filename}: {root}")
    if args.campaign_json:
        campaign_definition = json.loads(pathlib.Path(args.campaign_json).read_text(encoding="utf-8"))
        candidates = campaign_definition["candidates"]
    else:
        candidates = default_candidates()
    for candidate in candidates:
        validate_candidate(candidate)
    if len({candidate["id"] for candidate in candidates}) != len(candidates):
        raise SystemExit("candidate IDs must be unique")

    state = pathlib.Path(args.state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True)
    contract = campaign_contract(args, candidates, corpora)
    contract_path = state / "campaign-contract.json"
    if contract_path.exists():
        previous_contract = json.loads(contract_path.read_text(encoding="utf-8"))
        if previous_contract != contract:
            raise SystemExit(
                "campaign code, corpus, candidates, or resources changed; use a new --state-dir"
            )
    else:
        atomic_json(contract_path, contract)

    discovery = [run_candidate(args, candidate, args.seed, "discovery", corpora) for candidate in candidates]
    capability = [
        item for item in successful(discovery)
        if item["role"] != "systems" and (
            item["plastic_mode"] == "none"
            or bool((item.get("plastic_transfer") or {}).get("metrics", {}).get("passed"))
        )
    ]
    capability.sort(key=lambda item: item["final_eval_bits_per_byte"])
    top_ids = {item["id"] for item in capability[:max(args.replicate_top, 0)]}
    replication = [
        run_candidate(args, candidate, args.replication_seed, "replication", corpora)
        for candidate in candidates if candidate["id"] in top_ids
    ]

    discovery_map, replication_map = by_id(discovery), by_id(replication)
    replicated = []
    for candidate_id in sorted(set(discovery_map) & set(replication_map)):
        first, second = discovery_map[candidate_id], replication_map[candidate_id]
        replicated.append({
            "id": candidate_id,
            "mean_bits_per_byte": (
                first["final_eval_bits_per_byte"] + second["final_eval_bits_per_byte"]
            ) / 2,
            "seeds": [first["seed"], second["seed"]],
        })
    replicated.sort(key=lambda item: item["mean_bits_per_byte"])
    selected_id = replicated[0]["id"] if replicated else (capability[0]["id"] if capability else None)

    baseline_id = "baseline-hybrid-governed-byte"
    baseline = discovery_map.get(baseline_id)
    attention = discovery_map.get("comparator-attention-governed-byte")
    ssm = discovery_map.get("comparator-ssm-governed-byte")
    raw = discovery_map.get("comparator-hybrid-raw-code-byte")
    architecture_effects = (
        [improvement(comparator, baseline) for comparator in (attention, ssm)]
        if baseline and attention and ssm else []
    )
    corpus_effect = improvement(raw, baseline) if baseline and raw else None
    architecture_gate = bool(
        architecture_effects and min(architecture_effects) >= args.minimum_effect
    )
    corpus_gate = corpus_effect is not None and corpus_effect >= args.minimum_effect
    replication_agreement = bool(
        replicated and capability and replicated[0]["id"] == capability[0]["id"]
    )
    selected_improvement = None
    if selected_id and baseline and selected_id in discovery_map:
        selected_improvement = improvement(baseline, discovery_map[selected_id])
    autonomous_improvement_gate = bool(
        replication_agreement and selected_improvement is not None
        and selected_improvement >= args.minimum_effect
    )
    plastic_id = "candidate-plastic-hybrid-governed-byte"
    plastic_discovery = discovery_map.get(plastic_id)
    plastic_replication = replication_map.get(plastic_id)
    plastic_discovery_passed = bool(
        ((plastic_discovery or {}).get("plastic_transfer") or {}).get("metrics", {}).get("passed")
    )
    plastic_replication_passed = bool(
        ((plastic_replication or {}).get("plastic_transfer") or {}).get("metrics", {}).get("passed")
    )
    plasticity_gate = plastic_discovery_passed and plastic_replication_passed

    selection = {
        "schema": SCHEMA,
        "campaign_contract_digest": contract["contract_digest"],
        "implementation": contract["implementation"],
        "resource_match": {
            "same_gpu": True, "same_wall_clock_minutes": args.candidate_minutes,
            "same_precision": args.amp_dtype, "same_sequence_length": args.sequence_length,
            "same_batch_size": args.batch_size,
            "boundary": "Matched device time is a compute proxy, not measured joules or exact FLOPs.",
        },
        "candidates": candidates, "discovery": discovery, "replication": replication,
        "replicated_ranking": replicated, "selected_candidate": selected_id,
        "claim_tests": {
            "hybrid_substantially_outperforms_comparators": {
                "passed": architecture_gate, "minimum_relative_effect": args.minimum_effect,
                "effects_vs_attention_and_ssm": architecture_effects,
            },
            "governed_corpus_outperforms_raw_source": {
                "passed": corpus_gate, "minimum_relative_effect": args.minimum_effect,
                "relative_effect": corpus_effect,
                "boundary": "Measures held-out governed-record compression, not general intelligence.",
            },
            "autonomous_cycle_improves_baseline": {
                "passed": autonomous_improvement_gate,
                "replication_agreement": replication_agreement,
                "selected_relative_effect_vs_baseline": selected_improvement,
                "boundary": "Autonomous means predeclared execution, ranking, replication, and packaging; the search space remains human/code-authored.",
            },
            "plastic_state_improves_frozen_transfer": {
                "passed": plasticity_gate,
                "suite_supplied": args.plastic_suite is not None,
                "discovery_passed": plastic_discovery_passed,
                "replication_passed": plastic_replication_passed,
                "boundary": "Plastic candidates cannot be selected without a frozen excluded support-to-query gain on both seeds.",
            },
        },
        "promotion": "research-candidate-not-admitted",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    selection["receipt_digest"] = hashlib.sha256(stable_json(selection).encode()).hexdigest()
    atomic_json(state / "campaign-receipt.json", selection)
    if selected_id:
        selected_source = state / ("replication" if selected_id in replication_map else "discovery") / selected_id / "run"
        selected_target = state / "selected"
        selected_target.mkdir(parents=True, exist_ok=True)
        for filename in (
            "model.pt", "training-receipt.json", "plastic-transfer-receipt.json",
            "config.json", "tokenizer.json", "sample.txt",
        ):
            if (selected_source / filename).exists():
                shutil.copy2(selected_source / filename, selected_target / filename)
        atomic_json(selected_target / "selection-receipt.json", selection)
    print(json.dumps(selection, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
