from __future__ import annotations

import inspect
import os
import pathlib
import platform
import random
import time
from typing import Any

from .core import (
    SCHEMA_CONFIG,
    SCHEMA_TRAINING,
    manifest,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
)


def _supported(callable_object: Any, values: dict[str, Any]) -> dict[str, Any]:
    parameters = inspect.signature(callable_object).parameters
    if any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values()):
        return values
    return {key: value for key, value in values.items() if key in parameters}


def _directory_identity(root: pathlib.Path) -> dict[str, Any]:
    files = manifest(root)
    return {
        "digest": sha256_text(stable_json(files)),
        "file_count": len(files),
        "bytes": sum(int(item["bytes"]) for item in files),
        "files": files,
    }


def _training_text(tokenizer: Any, row: dict[str, Any]) -> str:
    messages = row.get("messages")
    answer = str(row.get("answer") or "").strip()
    if not isinstance(messages, list) or not messages or not answer:
        raise ValueError(f"Invalid training row {row.get('id', '<unknown>')}")
    conversation = [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in messages
        if isinstance(item, dict)
    ]
    conversation.append({"role": "assistant", "content": answer})
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(conversation, tokenize=False, add_generation_prompt=False)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in conversation)


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    dataset_path = pathlib.Path(args.dataset).resolve()
    model_dir = pathlib.Path(args.model).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if not model_dir.is_dir():
        raise SystemExit(f"Local student checkpoint is missing: {model_dir}")

    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    cfg = config.get("training") or {}
    seed = int(config.get("seed", 0))

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    random.seed(seed)

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
        from trl import SFTTrainer
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before CUDA training") from exc

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; CPU fallback is intentionally disabled")
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True

    rows = [row for row in read_jsonl(dataset_path) if str(row.get("split") or "train") == "train"]
    if not rows:
        raise SystemExit("No training rows were found")

    output.mkdir(parents=True)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    texts = [_training_text(tokenizer, row) for row in rows]
    order = [
        {"index": index, "id": str(row.get("id")), "text_sha256": sha256_text(text)}
        for index, (row, text) in enumerate(zip(rows, texts, strict=True))
    ]
    dataset = Dataset.from_list([{"text": text} for text in texts])

    compute_dtype = torch.float16
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
        raise SystemExit("The student did not load in 4-bit mode")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.config.use_cache = False

    training_values = {
        "output_dir": str(output / "checkpoints"),
        "num_train_epochs": float(cfg.get("epochs", 1.0)),
        "learning_rate": float(cfg.get("learning_rate", 2e-4)),
        "per_device_train_batch_size": int(cfg.get("batch_size", 1)),
        "gradient_accumulation_steps": int(cfg.get("gradient_accumulation_steps", 8)),
        "gradient_checkpointing": True,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": "paged_adamw_8bit",
        "dataloader_num_workers": 0,
        "logging_steps": int(cfg.get("logging_steps", 1)),
        "save_strategy": "epoch",
        "seed": seed,
        "data_seed": seed,
        "full_determinism": True,
        "tf32": False,
        "report_to": [],
        "remove_unused_columns": False,
        "bf16": False,
        "fp16": True,
    }
    training_args = TrainingArguments(**_supported(TrainingArguments.__init__, training_values))
    lora_values = {
        "r": int(cfg.get("lora_rank", 16)),
        "lora_alpha": int(cfg.get("lora_alpha", 32)),
        "lora_dropout": float(cfg.get("lora_dropout", 0.0)),
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": cfg.get("target_modules", "all-linear"),
    }
    trainer_values = {
        "model": model,
        "train_dataset": dataset,
        "peft_config": LoraConfig(**lora_values),
        "args": training_args,
        "dataset_text_field": "text",
        "max_seq_length": int(cfg.get("max_seq_length", 1024)),
        "packing": bool(cfg.get("packing", True)),
        "tokenizer": tokenizer,
        "processing_class": tokenizer,
    }
    trainer = SFTTrainer(**_supported(SFTTrainer.__init__, trainer_values))

    trainable = [name for name, parameter in trainer.model.named_parameters() if parameter.requires_grad]
    if not trainable:
        raise SystemExit("No trainable LoRA parameters were created")
    non_lora = [name for name in trainable if "lora_" not in name]
    if non_lora:
        raise SystemExit(f"Refusing non-LoRA trainable parameters: {non_lora[:8]}")

    started = time.monotonic()
    result = trainer.train()
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)

    gpu_index = torch.cuda.current_device()
    gpu = torch.cuda.get_device_properties(gpu_index)
    receipt: dict[str, Any] = {
        "schema": SCHEMA_TRAINING,
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "dataset": {
            "path": str(dataset_path),
            "sha256": sha256_file(dataset_path),
            "rows": len(rows),
            "order_digest": sha256_text(stable_json(order)),
        },
        "student_checkpoint": {"path": str(model_dir), **_directory_identity(model_dir)},
        "adapter": {"path": str(adapter_dir), **_directory_identity(adapter_dir)},
        "optimization": {
            "method": "cuda-nf4-double-quant-qlora-final-answer-sft",
            "epochs": float(cfg.get("epochs", 1.0)),
            "learning_rate": float(cfg.get("learning_rate", 2e-4)),
            "lora": lora_values,
            "max_seq_length": int(cfg.get("max_seq_length", 1024)),
            "packing": bool(cfg.get("packing", True)),
            "trainable_parameter_names": trainable,
        },
        "runtime": {
            "seconds": round(time.monotonic() - started, 3),
            "python": platform.python_version(),
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "gpu": {
                "index": gpu_index,
                "name": torch.cuda.get_device_name(gpu_index),
                "capability": list(torch.cuda.get_device_capability(gpu_index)),
                "total_memory_bytes": gpu.total_memory,
            },
        },
        "train_metrics": result.metrics,
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "training-receipt.json", receipt)
    return receipt
