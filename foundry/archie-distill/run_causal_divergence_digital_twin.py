#!/usr/bin/env python3
"""Fail-closed Linux digital twin for Archie's causal-divergence CUDA trainer.

This validates the exact staged profile, workspace, preference bytes, local model
checkpoint, tokenizer, package environment, tokenization, and trainer refusal
boundary on a Linux host where CUDA is unavailable. It never performs a gradient
step and never emits a CUDA neural-training receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import time
from typing import Any, Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import (  # type: ignore
    directory_identity,
    package_versions,
    read_json,
    read_jsonl,
    require_profile,
    sha256,
    stable,
    tokenizer_identity,
)
from train_causal_divergence import METHOD, PAIR_SCHEMA, tokenize_pair  # type: ignore

SCHEMA = "archie-neural-linux-digital-twin-receipt/v1"
PAIR_RECEIPT_SCHEMA = "archie-causal-divergence-dataset-receipt/v1"
EXPECTED_REFUSAL = "Archie causal-divergence QLoRA requires a supported local CUDA GPU. Refusing CPU fallback."
REQUIRED_PACKAGES = ["torch", "transformers", "datasets", "peft", "bitsandbytes", "accelerate"]


def verify_digest_bound_json(path: pathlib.Path, *, schema: str, digest_field: str) -> tuple[dict[str, Any], str]:
    value = read_json(path)
    if value.get("schema") != schema:
        raise SystemExit(f"Unexpected schema in {path}: {value.get('schema')!r}.")
    body = dict(value)
    claimed = str(body.pop(digest_field, ""))
    observed = hashlib.sha256(stable(body).encode("utf-8")).hexdigest()
    if claimed != observed:
        raise SystemExit(f"{path} failed {digest_field} integrity verification.")
    return value, claimed


def verify_bundle(
    *,
    profile_path: pathlib.Path,
    workspace: pathlib.Path,
    preference_path: pathlib.Path,
    preference_eval_path: pathlib.Path | None,
    preference_receipt_path: pathlib.Path,
    model_dir: pathlib.Path,
) -> dict[str, Any]:
    profile = read_json(profile_path)
    training = require_profile(profile)
    if training.get("method") != METHOD:
        raise SystemExit("Profile does not select verifier-anchored causal-divergence QLoRA.")

    plan_path = workspace / "training-plan.json"
    plan = read_json(plan_path)
    if plan.get("schema") != "archie-training-plan/v1":
        raise SystemExit("Workspace does not contain an Archie training plan v1.")

    preference_receipt, preference_receipt_digest = verify_digest_bound_json(
        preference_receipt_path,
        schema=PAIR_RECEIPT_SCHEMA,
        digest_field="receipt_digest",
    )
    train_rows = read_jsonl(preference_path, required=True)
    eval_rows = read_jsonl(preference_eval_path) if preference_eval_path else []
    if not train_rows:
        raise SystemExit("Digital twin requires at least one causal-divergence training pair.")
    for row in train_rows + eval_rows:
        if row.get("schema") != PAIR_SCHEMA:
            raise SystemExit(f"Unexpected preference row schema for {row.get('pair_id', '<unknown>')}.")

    expected_pair_digests = sorted(str(item) for item in preference_receipt.get("pair_digests") or [])
    observed_pair_digests = sorted(str(row.get("pair_digest") or "") for row in train_rows + eval_rows)
    if expected_pair_digests != observed_pair_digests:
        raise SystemExit("Preference rows do not exactly match the bound dataset receipt.")

    if not model_dir.is_dir():
        raise SystemExit(f"Student checkpoint is missing: {model_dir}")
    model_identity = directory_identity(model_dir)
    tokenizer_files = tokenizer_identity(model_dir)
    if model_identity["file_count"] <= 0:
        raise SystemExit("Student checkpoint directory is empty.")
    if tokenizer_files["file_count"] <= 0:
        raise SystemExit("Student checkpoint has no local tokenizer artifacts.")

    return {
        "profile": profile,
        "training": training,
        "plan": plan,
        "plan_path": plan_path,
        "preference_receipt": preference_receipt,
        "preference_receipt_digest": preference_receipt_digest,
        "train_rows": train_rows,
        "eval_rows": eval_rows,
        "model_identity": model_identity,
        "tokenizer_identity": tokenizer_files,
    }


def default_runtime_probe(model_dir: pathlib.Path, rows: list[dict[str, Any]], max_seq_length: int) -> dict[str, Any]:
    try:
        import torch
        from peft import LoraConfig
        from transformers import AutoConfig, AutoTokenizer, TrainingArguments
    except Exception as exc:
        raise SystemExit("Pinned causal-divergence runtime dependencies are not installed.") from exc

    versions = package_versions(REQUIRED_PACKAGES)
    missing = [name for name, value in versions.items() if value is None]
    if missing:
        raise SystemExit(f"Pinned causal-divergence packages are missing: {', '.join(missing)}")
    if torch.cuda.is_available():
        raise SystemExit("Linux digital twin requires CUDA to be unavailable so the neural trainer can be proven fail-closed.")

    config = AutoConfig.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenized = [tokenize_pair(tokenizer, row, max_seq_length) for row in rows]
    if not tokenized:
        raise SystemExit("No preference rows survived digital-twin tokenization.")

    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.0,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules="all-linear",
    )
    training_arguments = TrainingArguments(
        output_dir=str(model_dir / ".archie-digital-twin-forbidden-output"),
        num_train_epochs=1,
        learning_rate=0.0001,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        report_to=[],
        remove_unused_columns=False,
    )
    order = [
        {"pair_id": item["pair_id"], "divergence_target_token": item["divergence_target_token"]}
        for item in tokenized
    ]
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": versions,
        "cuda_available": False,
        "torch_cuda_build": torch.version.cuda,
        "model_config": {
            "model_type": getattr(config, "model_type", None),
            "architectures": list(getattr(config, "architectures", None) or []),
        },
        "tokenization": {
            "rows": len(tokenized),
            "order_digest": hashlib.sha256(stable(order).encode("utf-8")).hexdigest(),
            "maximum_sequence_length": max(
                max(len(item["chosen_input_ids"]), len(item["rejected_input_ids"])) for item in tokenized
            ),
        },
        "lora_construction": {
            "r": lora.r,
            "lora_alpha": lora.lora_alpha,
            "target_modules": lora.target_modules,
            "task_type": str(lora.task_type),
        },
        "trainer_construction": {
            "epochs": training_arguments.num_train_epochs,
            "learning_rate": training_arguments.learning_rate,
            "batch_size": training_arguments.per_device_train_batch_size,
            "gradient_accumulation_steps": training_arguments.gradient_accumulation_steps,
        },
    }


def default_trainer_probe(command: list[str], *, environment: dict[str, str]) -> dict[str, Any]:
    completed = subprocess.run(command, env=environment, capture_output=True, text=True, check=False)
    combined = f"{completed.stdout}\n{completed.stderr}".strip()
    if completed.returncode == 0:
        raise SystemExit("Neural trainer unexpectedly succeeded during the non-neural digital twin.")
    if EXPECTED_REFUSAL not in combined:
        raise SystemExit("Neural trainer did not stop at the canonical CUDA refusal boundary.")
    return {
        "exit_code": completed.returncode,
        "canonical_refusal_observed": True,
        "output_sha256": hashlib.sha256(combined.encode("utf-8")).hexdigest(),
    }


def execute_digital_twin(
    *,
    profile_path: pathlib.Path,
    workspace: pathlib.Path,
    preference_path: pathlib.Path,
    preference_eval_path: pathlib.Path | None,
    preference_receipt_path: pathlib.Path,
    model_dir: pathlib.Path,
    output: pathlib.Path,
    max_seq_length: int,
    runtime_probe: Callable[[pathlib.Path, list[dict[str, Any]], int], dict[str, Any]] = default_runtime_probe,
    trainer_probe: Callable[..., dict[str, Any]] = default_trainer_probe,
) -> dict[str, Any]:
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing digital-twin output: {output}")

    bundle = verify_bundle(
        profile_path=profile_path,
        workspace=workspace,
        preference_path=preference_path,
        preference_eval_path=preference_eval_path,
        preference_receipt_path=preference_receipt_path,
        model_dir=model_dir,
    )
    rows = bundle["train_rows"] + bundle["eval_rows"]
    runtime = runtime_probe(model_dir, rows, max_seq_length)

    forbidden_output = output.with_name(f"{output.name}-forbidden-neural-output")
    if forbidden_output.exists():
        raise SystemExit(f"Refusing stale forbidden neural output path: {forbidden_output}")
    trainer_path = pathlib.Path(__file__).resolve().with_name("train_causal_divergence.py")
    command = [
        sys.executable,
        str(trainer_path),
        "--profile", str(profile_path),
        "--workspace", str(workspace),
        "--preference-data", str(preference_path),
        "--preference-receipt", str(preference_receipt_path),
        "--model-dir", str(model_dir),
        "--output", str(forbidden_output),
        "--max-seq-length", str(max_seq_length),
    ]
    if preference_eval_path:
        command.extend(["--preference-eval-data", str(preference_eval_path)])
    environment = dict(os.environ)
    environment.update({
        "CUDA_VISIBLE_DEVICES": "",
        "NVIDIA_VISIBLE_DEVICES": "void",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
    })
    boundary = trainer_probe(command, environment=environment)
    if forbidden_output.exists():
        raise SystemExit("Neural trainer created output during the digital twin; refusing a false receipt.")

    receipt = {
        "schema": SCHEMA,
        "method": METHOD,
        "executionMode": "linux-digital-twin",
        "neuralEvidence": False,
        "profile": {"id": bundle["profile"].get("id"), "sha256": sha256(profile_path)},
        "training_plan": {
            "path": str(bundle["plan_path"]),
            "sha256": sha256(bundle["plan_path"]),
            "plan_digest": bundle["plan"].get("plan_digest"),
        },
        "preference_dataset": {
            "train": {"path": str(preference_path), "sha256": sha256(preference_path), "rows": len(bundle["train_rows"])},
            "development": {
                "path": str(preference_eval_path),
                "sha256": sha256(preference_eval_path),
                "rows": len(bundle["eval_rows"]),
            } if preference_eval_path else None,
            "receipt": {
                "path": str(preference_receipt_path),
                "sha256": sha256(preference_receipt_path),
                "receipt_digest": bundle["preference_receipt_digest"],
            },
        },
        "student_checkpoint": {
            "path": str(model_dir),
            "revision": bundle["profile"].get("student", {}).get("revision"),
            **bundle["model_identity"],
            "tokenizer": bundle["tokenizer_identity"],
        },
        "runtime": runtime,
        "trainer_boundary": boundary,
        "gradient_steps": 0,
        "optimizer_steps": 0,
        "adapter_artifacts": [],
        "neural_training_receipt_emitted": False,
        "promotion": "not-admitted",
        "claim_boundary": "The exact staged Linux bundle passed non-neural validation and the real trainer refused CPU fallback. No CUDA gradient, learned adapter, checkpoint, evaluation gain, or admission exists.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable(receipt).encode("utf-8")).hexdigest()
    output.mkdir(parents=True)
    (output / "digital-twin-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--preference-data", required=True)
    parser.add_argument("--preference-eval-data")
    parser.add_argument("--preference-receipt", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-seq-length", type=int, default=1536)
    args = parser.parse_args()
    execute_digital_twin(
        profile_path=pathlib.Path(args.profile).resolve(),
        workspace=pathlib.Path(args.workspace).resolve(),
        preference_path=pathlib.Path(args.preference_data).resolve(),
        preference_eval_path=pathlib.Path(args.preference_eval_data).resolve() if args.preference_eval_data else None,
        preference_receipt_path=pathlib.Path(args.preference_receipt).resolve(),
        model_dir=pathlib.Path(args.model_dir).resolve(),
        output=pathlib.Path(args.output).resolve(),
        max_seq_length=args.max_seq_length,
    )


if __name__ == "__main__":
    main()
