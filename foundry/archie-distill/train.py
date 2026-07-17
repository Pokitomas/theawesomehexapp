#!/usr/bin/env python3
"""Evidence-bound, CUDA-only QLoRA training entrypoint for Archie.

This performs real 4-bit NF4 QLoRA gradient updates against a pinned local
student checkpoint. It accepts compiled Archie training workspaces, mixes
continued-pretraining and trajectory SFT, turns admitted negative trajectories
into explicit correction targets, evaluates on the development split, and
emits a byte-bound receipt. It never downloads weights, silently falls back to
full-precision CPU training, or promotes the result.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import inspect
import json
import os
import pathlib
import platform
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


def directory_identity(root: pathlib.Path) -> dict[str, Any]:
    files = artifact_manifest(root)
    return {
        "digest": hashlib.sha256(stable(files).encode("utf-8")).hexdigest(),
        "file_count": len(files),
        "bytes": sum(item["bytes"] for item in files),
    }


def tokenizer_identity(root: pathlib.Path) -> dict[str, Any]:
    names = {
        "added_tokens.json",
        "chat_template.jinja",
        "merges.txt",
        "special_tokens_map.json",
        "tokenizer.json",
        "tokenizer.model",
        "tokenizer_config.json",
        "vocab.json",
    }
    files = [
        item for item in artifact_manifest(root)
        if pathlib.PurePosixPath(item["path"]).name in names
        or pathlib.PurePosixPath(item["path"]).name.startswith("tokenizer")
    ]
    return {
        "digest": hashlib.sha256(stable(files).encode("utf-8")).hexdigest(),
        "file_count": len(files),
        "files": files,
    }


def dataset_identity(paths: dict[str, pathlib.Path]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, path in paths.items():
        result[name] = {
            "present": path.exists(),
            "bytes": path.stat().st_size if path.exists() else 0,
            "sha256": sha256(path) if path.exists() else None,
        }
    return result


def package_versions(names: list[str]) -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


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
    parser.add_argument("--max-seq-length", type=int, default=1024)
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

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    random.seed(seed)

    plan_path = workspace / "training-plan.json"
    plan = read_json(plan_path)
    if plan.get("schema") != "archie-training-plan/v1":
        raise SystemExit("Workspace does not contain an Archie training plan v1.")

    datasets_dir = workspace / "datasets"
    dataset_paths = {
        "continued_pretraining": datasets_dir / "pretrain.train.jsonl",
        "trajectory_sft": datasets_dir / "sft.train.jsonl",
        "negative_correction": datasets_dir / "negative.train.jsonl",
        "development_holdout": datasets_dir / "development-holdout.jsonl",
    }
    pretrain_rows = read_jsonl(dataset_paths["continued_pretraining"])
    sft_rows = read_jsonl(dataset_paths["trajectory_sft"])
    negative_rows = read_jsonl(dataset_paths["negative_correction"])
    development_rows = read_jsonl(dataset_paths["development_holdout"])
    if not sft_rows and not negative_rows and not pretrain_rows:
        raise SystemExit("No neural training rows were supplied.")

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
        from trl import SFTTrainer
    except Exception as exc:
        raise SystemExit("Pinned CUDA QLoRA dependencies are not installed in this environment.") from exc

    if not torch.cuda.is_available():
        raise SystemExit(
            "Archie QLoRA requires a supported local CUDA GPU. "
            "Refusing slow full-precision CPU training."
        )

    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True

    model_dir = pathlib.Path(args.model_dir).resolve() if args.model_dir else workspace / "models" / "student"
    if not model_dir.exists():
        raise SystemExit(f"Student checkpoint is missing: {model_dir}")
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    checkpoint_identity = directory_identity(model_dir)
    checkpoint_tokenizer_identity = tokenizer_identity(model_dir)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    compute_dtype = torch.float16
    quantization_values = {
        "load_in_4bit": True,
        "bnb_4bit_quant_type": "nf4",
        "bnb_4bit_use_double_quant": True,
        "bnb_4bit_compute_dtype": "float16",
    }
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    if not getattr(model, "is_loaded_in_4bit", False):
        raise SystemExit("Student checkpoint did not load in 4-bit mode; refusing a false QLoRA receipt.")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
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
    training_order = [
        {"index": index, "lane": row["lane"], "text_sha256": hashlib.sha256(row["text"].encode("utf-8")).hexdigest()}
        for index, row in enumerate(neural_rows)
    ]
    training_order_digest = hashlib.sha256(stable(training_order).encode("utf-8")).hexdigest()

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
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": "paged_adamw_8bit",
        "dataloader_num_workers": 0,
        "logging_steps": 1,
        "save_strategy": "epoch",
        "eval_strategy": "epoch" if eval_dataset is not None else "no",
        "evaluation_strategy": "epoch" if eval_dataset is not None else "no",
        "seed": seed,
        "data_seed": seed,
        "full_determinism": True,
        "tf32": False,
        "report_to": [],
        "remove_unused_columns": False,
        "bf16": False,
        "fp16": True,
    }
    training_args = TrainingArguments(**supported_kwargs(TrainingArguments.__init__, training_argument_values))
    lora_values = {
        "r": int(cfg["lora_rank"]),
        "lora_alpha": int(cfg["lora_alpha"]),
        "lora_dropout": float(cfg.get("lora_dropout", 0.0)),
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": cfg.get("target_modules", "all-linear"),
    }
    trainer_values = {
        "model": model,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
        "peft_config": LoraConfig(**lora_values),
        "args": training_args,
        "dataset_text_field": "text",
        "max_seq_length": args.max_seq_length,
        "packing": bool(cfg.get("packing", True)),
        "tokenizer": tokenizer,
        "processing_class": tokenizer,
    }
    trainer = SFTTrainer(**supported_kwargs(SFTTrainer.__init__, trainer_values))
    trainable_parameters = [name for name, parameter in trainer.model.named_parameters() if parameter.requires_grad]
    if not trainable_parameters:
        raise SystemExit("QLoRA produced zero trainable adapter parameters.")
    non_adapter_parameters = [name for name in trainable_parameters if "lora_" not in name]
    if non_adapter_parameters:
        raise SystemExit(f"QLoRA attempted to train non-adapter parameters: {non_adapter_parameters[:8]}")

    result = trainer.train()
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    evaluation = trainer.evaluate() if eval_dataset is not None else None

    gpu_index = torch.cuda.current_device()
    gpu_properties = torch.cuda.get_device_properties(gpu_index)
    receipt = {
        "schema": SCHEMA,
        "profile": {"id": profile.get("id"), "sha256": sha256(profile_path)},
        "training_plan": {"sha256": sha256(plan_path), "plan_digest": plan.get("plan_digest")},
        "student_checkpoint": {
            "path": str(model_dir),
            "revision": profile.get("student", {}).get("revision"),
            **checkpoint_identity,
            "tokenizer": checkpoint_tokenizer_identity,
        },
        "datasets": {
            "identities": dataset_identity(dataset_paths),
            "continued_pretraining_rows": len(pretrain_rows),
            "trajectory_sft_rows": len(sft_rows),
            "negative_correction_rows": len(negative_rows),
            "development_rows": len(development_rows),
            "effective_train_rows": len(neural_rows),
            "training_order_digest": training_order_digest,
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packages": package_versions(["torch", "transformers", "datasets", "peft", "trl", "bitsandbytes", "accelerate"]),
            "cuda": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "gpu": {
                "index": gpu_index,
                "name": torch.cuda.get_device_name(gpu_index),
                "capability": list(torch.cuda.get_device_capability(gpu_index)),
                "total_memory_bytes": gpu_properties.total_memory,
            },
        },
        "optimization": {
            "method": "cuda-nf4-double-quant-qlora-multilane-sft",
            "quantization": quantization_values,
            "optimizer": "paged_adamw_8bit",
            "seed": seed,
            "epochs": float(cfg["epochs"]),
            "learning_rate": float(cfg["learning_rate"]),
            "lora": lora_values,
            "trainable_parameter_names": trainable_parameters,
            "max_seq_length": args.max_seq_length,
            "batch_size": args.batch_size,
            "gradient_accumulation_steps": args.gradient_accumulation_steps,
            "gradient_checkpointing": True,
            "packing": bool(cfg.get("packing", True)),
            "pretrain_weight": args.pretrain_weight,
            "determinism": {
                "cublas_workspace_config": os.environ["CUBLAS_WORKSPACE_CONFIG"],
                "deterministic_algorithms": True,
                "tf32": False,
                "dataloader_num_workers": 0,
                "claim": "Deterministic reproduction is bounded to the same pinned checkpoint, data order, GPU class, CUDA stack, and library versions.",
            },
        },
        "train_metrics": result.metrics,
        "development_metrics": evaluation,
        "artifacts": artifact_manifest(adapter_dir),
        "promotion": "not-admitted",
        "claim_boundary": "Real local CUDA NF4 QLoRA gradient training completed. Capability, safety, authority, and production promotion remain unproven until independent hidden evaluation and admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable(receipt).encode("utf-8")).hexdigest()
    (output / "training-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
