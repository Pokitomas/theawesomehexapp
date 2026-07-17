#!/usr/bin/env python3
"""Evidence-bound neural training entrypoint for Archie.

This performs real gradient updates against the local student checkpoint. It accepts
compiled Archie training workspaces, mixes continued-pretraining and trajectory SFT,
turns admitted negative trajectories into explicit correction targets, evaluates on
the development split, and emits a byte-bound receipt. It never promotes the result.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import pathlib
import random
import time
from typing import Any

SCHEMA = "archie-neural-training-receipt/v2"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    return value


def read_jsonl(path: pathlib.Path, *, required: bool = False) -> list[dict[str, Any]]:
    if not path.exists():
        if required:
            raise SystemExit(f"Required dataset is missing: {path}")
        return []
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSONL at {path}:{number}: {exc}") from exc
        if not isinstance(value, dict):
            raise SystemExit(f"Dataset row at {path}:{number} must be an object.")
        rows.append(value)
    return rows


def require_profile(profile: dict[str, Any]) -> dict[str, Any]:
    if profile.get("schema") != "archie-distill-profile/v1":
        raise SystemExit("Unsupported distillation profile schema.")
    training = profile.get("training")
    if not isinstance(training, dict):
        raise SystemExit("Profile training configuration is missing.")
    for key in ("seed", "epochs", "learning_rate", "lora_rank", "lora_alpha"):
        if key not in training:
            raise SystemExit(f"Profile training.{key} is required.")
    return training


def correction_target(row: dict[str, Any]) -> str:
    reason = str(row.get("reason") or "The demonstrated action was rejected by independent verification.").strip()
    return stable({
        "decision": "reject-and-replan",
        "reason": reason,
        "required_behavior": "Do not repeat the rejected trajectory. Re-evaluate constraints, authority, evidence, and verification before proposing a replacement plan.",
    })


def conversation_text(tokenizer: Any, row: dict[str, Any], target: str) -> str:
    instruction = str(row.get("instruction") or "").strip()
    if not instruction:
        raise SystemExit(f"Training sample {row.get('sample_id', '<unknown>')} has no instruction.")
    context = row.get("compact_context")
    user = instruction if context in (None, {}, []) else f"{instruction}\n\nContext:\n{stable(context)}"
    messages = [
        {"role": "system", "content": "You are Archie. Produce typed, permission-aware plans and corrections grounded in verifiable evidence."},
        {"role": "user", "content": user},
        {"role": "assistant", "content": target},
    ]
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages)


def artifact_manifest(root: pathlib.Path) -> list[dict[str, Any]]:
    files = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        files.append({
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    return files


def choose_dtype(torch: Any) -> Any:
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    if torch.cuda.is_available():
        return torch.float16
    return torch.float32


def supported_kwargs(callable_object: Any, values: dict[str, Any]) -> dict[str, Any]:
    """Filter optional compatibility kwargs against the installed library signature."""
    parameters = inspect.signature(callable_object).parameters
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
        return values
    return {key: value for key, value in values.items() if key in parameters}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--workspace", required=True, help="Compiled Archie training workspace")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-dir", help="Override workspace/models/student")
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--pretrain-weight", type=float, default=0.25)
    args = parser.parse_args()

    profile_path = pathlib.Path(args.profile).resolve()
    workspace = pathlib.Path(args.workspace).resolve()
    output = pathlib.Path(args.output).resolve()
    profile = read_json(profile_path)
    cfg = require_profile(profile)
    seed = int(cfg["seed"])
    random.seed(seed)
    os.environ.setdefault("PYTHONHASHSEED", str(seed))

    plan_path = workspace / "training-plan.json"
    plan = read_json(plan_path)
    if plan.get("schema") != "archie-training-plan/v1":
        raise SystemExit("Workspace does not contain an Archie training plan v1.")

    datasets_dir = workspace / "datasets"
    pretrain_rows = read_jsonl(datasets_dir / "pretrain.train.jsonl")
    sft_rows = read_jsonl(datasets_dir / "sft.train.jsonl")
    negative_rows = read_jsonl(datasets_dir / "negative.train.jsonl")
    development_rows = read_jsonl(datasets_dir / "development-holdout.jsonl")
    if not sft_rows and not negative_rows and not pretrain_rows:
        raise SystemExit("No neural training rows were supplied.")

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
        from trl import SFTTrainer
    except Exception as exc:
        raise SystemExit("Pinned neural training dependencies are not installed in this environment.") from exc

    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    model_dir = pathlib.Path(args.model_dir).resolve() if args.model_dir else workspace / "models" / "student"
    if not model_dir.exists():
        raise SystemExit(f"Student checkpoint is missing: {model_dir}")
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    dtype = choose_dtype(torch)
    quantization = None
    if torch.cuda.is_available():
        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=dtype,
        )
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map="auto" if torch.cuda.is_available() else None,
        torch_dtype=None if quantization else dtype,
        local_files_only=True,
        trust_remote_code=False,
    )
    model.config.use_cache = False

    neural_rows: list[dict[str, str]] = []
    for row in sft_rows:
        target = row.get("target")
        if not isinstance(target, str) or not target.strip():
            raise SystemExit(f"Positive sample {row.get('sample_id')} has no target.")
        neural_rows.append({"text": conversation_text(tokenizer, row, target), "lane": "trajectory-sft"})
    for row in negative_rows:
        neural_rows.append({"text": conversation_text(tokenizer, row, correction_target(row)), "lane": "negative-correction"})
    for row in pretrain_rows:
        text = str(row.get("text") or "").strip()
        if text and random.random() < max(0.0, min(1.0, args.pretrain_weight)):
            neural_rows.append({"text": text, "lane": "continued-pretraining"})
    random.shuffle(neural_rows)
    if not neural_rows:
        raise SystemExit("Dataset mixing produced zero training rows.")

    eval_rows: list[dict[str, str]] = []
    for row in development_rows:
        if row.get("kind") == "continued-pretraining":
            text = str(row.get("text") or "").strip()
        elif row.get("kind") == "negative-suppression":
            text = conversation_text(tokenizer, row, correction_target(row))
        else:
            target = str(row.get("target") or "").strip()
            text = conversation_text(tokenizer, row, target) if target else ""
        if text:
            eval_rows.append({"text": text})

    train_dataset = Dataset.from_list(neural_rows)
    eval_dataset = Dataset.from_list(eval_rows) if eval_rows else None
    training_argument_values = {
        "output_dir": str(output / "checkpoints"),
        "num_train_epochs": float(cfg["epochs"]),
        "learning_rate": float(cfg["learning_rate"]),
        "per_device_train_batch_size": args.batch_size,
        "per_device_eval_batch_size": args.batch_size,
        "gradient_accumulation_steps": args.gradient_accumulation_steps,
        "gradient_checkpointing": True,
        "logging_steps": 1,
        "save_strategy": "epoch",
        "eval_strategy": "epoch" if eval_dataset is not None else "no",
        "evaluation_strategy": "epoch" if eval_dataset is not None else "no",
        "seed": seed,
        "data_seed": seed,
        "report_to": [],
        "remove_unused_columns": False,
        "bf16": dtype == torch.bfloat16,
        "fp16": dtype == torch.float16,
    }
    training_args = TrainingArguments(**supported_kwargs(TrainingArguments.__init__, training_argument_values))
    trainer_values = {
        "model": model,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
        "peft_config": LoraConfig(
            r=int(cfg["lora_rank"]),
            lora_alpha=int(cfg["lora_alpha"]),
            lora_dropout=float(cfg.get("lora_dropout", 0.05)),
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=cfg.get("target_modules", "all-linear"),
        ),
        "args": training_args,
        "dataset_text_field": "text",
        "max_seq_length": args.max_seq_length,
        "packing": bool(cfg.get("packing", True)),
        "tokenizer": tokenizer,
        "processing_class": tokenizer,
    }
    trainer = SFTTrainer(**supported_kwargs(SFTTrainer.__init__, trainer_values))

    result = trainer.train()
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    evaluation = trainer.evaluate() if eval_dataset is not None else None

    receipt = {
        "schema": SCHEMA,
        "profile": {"id": profile.get("id"), "sha256": sha256(profile_path)},
        "training_plan": {"sha256": sha256(plan_path), "plan_digest": plan.get("plan_digest")},
        "student_checkpoint": {"path": str(model_dir), "revision": profile.get("student", {}).get("revision")},
        "datasets": {
            "continued_pretraining_rows": len(pretrain_rows),
            "trajectory_sft_rows": len(sft_rows),
            "negative_correction_rows": len(negative_rows),
            "development_rows": len(development_rows),
            "effective_train_rows": len(neural_rows),
        },
        "optimization": {
            "method": "qlora-multilane-sft",
            "seed": seed,
            "epochs": float(cfg["epochs"]),
            "learning_rate": float(cfg["learning_rate"]),
            "lora_rank": int(cfg["lora_rank"]),
            "lora_alpha": int(cfg["lora_alpha"]),
            "max_seq_length": args.max_seq_length,
            "pretrain_weight": args.pretrain_weight,
        },
        "train_metrics": result.metrics,
        "development_metrics": evaluation,
        "artifacts": artifact_manifest(adapter_dir),
        "promotion": "not-admitted",
        "claim_boundary": "Real local gradient training completed. Capability, safety, authority, and production promotion remain unproven until independent hidden evaluation and admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable(receipt).encode("utf-8")).hexdigest()
    (output / "training-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
