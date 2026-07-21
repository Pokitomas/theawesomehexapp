from __future__ import annotations

import contextlib
import inspect
import os
import pathlib
import platform
import random
import time
from dataclasses import dataclass
from typing import Any

from .core import (
    SCHEMA_CONFIG,
    SCHEMA_PREFERENCE_DATASET,
    SCHEMA_PREFERENCE_TRAINING,
    directory_identity,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
)
from .pairs import PAIR_SCHEMA


def _supported(callable_object: Any, values: dict[str, Any]) -> dict[str, Any]:
    parameters = inspect.signature(callable_object).parameters
    if any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values()):
        return values
    return {key: value for key, value in values.items() if key in parameters}


def common_prefix_length(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def prompt_text(tokenizer: Any, row: dict[str, Any]) -> str:
    messages = row.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError(f"Preference pair {row.get('pair_id', '<unknown>')} has no messages")
    clean = [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in messages
        if isinstance(item, dict)
    ]
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(clean, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in clean) + "\n<assistant>\n"


def tokenize_pair(tokenizer: Any, row: dict[str, Any], max_seq_length: int) -> dict[str, Any]:
    if row.get("schema") != PAIR_SCHEMA:
        raise ValueError(f"Unsupported preference pair schema for {row.get('pair_id', '<unknown>')}")
    chosen = str(row.get("chosen") or "").strip()
    rejected = str(row.get("rejected") or "").strip()
    if not chosen or not rejected or chosen == rejected:
        raise ValueError(f"Preference pair {row.get('pair_id')} must contain distinct chosen and rejected targets")
    prompt_ids = tokenizer(prompt_text(tokenizer, row), add_special_tokens=False)["input_ids"]
    chosen_ids = tokenizer(chosen, add_special_tokens=False)["input_ids"]
    rejected_ids = tokenizer(rejected, add_special_tokens=False)["input_ids"]
    eos = [tokenizer.eos_token_id] if tokenizer.eos_token_id is not None else []
    divergence = common_prefix_length(chosen_ids, rejected_ids)
    if divergence >= min(len(chosen_ids), len(rejected_ids)):
        raise ValueError(f"Preference pair {row.get('pair_id')} has no divergence before one target ends")

    def build(target_ids: list[int]) -> tuple[list[int], list[int], list[int]]:
        available = max_seq_length - len(prompt_ids)
        if available <= 1:
            raise ValueError(f"Preference prompt {row.get('pair_id')} consumes the sequence budget")
        target = (target_ids + eos)[:available]
        input_ids = (prompt_ids + target)[:max_seq_length]
        sft_labels = [-100] * len(prompt_ids) + target
        divergence_labels = [-100] * (len(prompt_ids) + min(divergence, len(target))) + target[min(divergence, len(target)):]
        return input_ids, sft_labels[:len(input_ids)], divergence_labels[:len(input_ids)]

    chosen_input_ids, chosen_sft_labels, chosen_divergence_labels = build(chosen_ids)
    rejected_input_ids, _, rejected_divergence_labels = build(rejected_ids)
    if not any(item != -100 for item in chosen_divergence_labels):
        raise ValueError(f"Preference pair {row.get('pair_id')} was truncated before chosen divergence")
    if not any(item != -100 for item in rejected_divergence_labels):
        raise ValueError(f"Preference pair {row.get('pair_id')} was truncated before rejected divergence")
    return {
        "pair_id": row.get("pair_id"),
        "chosen_input_ids": chosen_input_ids,
        "chosen_sft_labels": chosen_sft_labels,
        "chosen_divergence_labels": chosen_divergence_labels,
        "rejected_input_ids": rejected_input_ids,
        "rejected_divergence_labels": rejected_divergence_labels,
        "evidence_weight": max(0.25, min(4.0, float(row.get("evidence_weight", 1.0)))),
        "divergence_target_token": divergence,
    }


@dataclass
class CausalDivergenceCollator:
    pad_token_id: int

    def _pad(self, rows: list[list[int]], value: int) -> Any:
        import torch
        width = max(len(row) for row in rows)
        return torch.tensor([row + [value] * (width - len(row)) for row in rows], dtype=torch.long)

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        import torch
        chosen_ids = [item["chosen_input_ids"] for item in features]
        rejected_ids = [item["rejected_input_ids"] for item in features]
        return {
            "chosen_input_ids": self._pad(chosen_ids, self.pad_token_id),
            "chosen_attention_mask": self._pad([[1] * len(row) for row in chosen_ids], 0),
            "chosen_sft_labels": self._pad([item["chosen_sft_labels"] for item in features], -100),
            "chosen_divergence_labels": self._pad([item["chosen_divergence_labels"] for item in features], -100),
            "rejected_input_ids": self._pad(rejected_ids, self.pad_token_id),
            "rejected_attention_mask": self._pad([[1] * len(row) for row in rejected_ids], 0),
            "rejected_divergence_labels": self._pad([item["rejected_divergence_labels"] for item in features], -100),
            "evidence_weight": torch.tensor([item["evidence_weight"] for item in features], dtype=torch.float32),
        }


def sequence_log_prob(logits: Any, labels: Any) -> Any:
    import torch
    import torch.nn.functional as functional
    shifted_logits = logits[:, :-1, :].float()
    shifted_labels = labels[:, 1:]
    mask = shifted_labels.ne(-100)
    safe_labels = shifted_labels.masked_fill(~mask, 0)
    token_log_probs = functional.log_softmax(shifted_logits, dim=-1).gather(-1, safe_labels.unsqueeze(-1)).squeeze(-1)
    token_log_probs = token_log_probs * mask
    lengths = mask.sum(dim=-1).clamp_min(1)
    return token_log_probs.sum(dim=-1) / torch.sqrt(lengths.float())


def sft_loss(logits: Any, labels: Any) -> Any:
    import torch.nn.functional as functional
    return functional.cross_entropy(
        logits[:, :-1, :].contiguous().float().view(-1, logits.shape[-1]),
        labels[:, 1:].contiguous().view(-1),
        ignore_index=-100,
    )


def causal_divergence_loss(
    *,
    policy_chosen_logits: Any,
    policy_rejected_logits: Any,
    reference_chosen_logits: Any,
    reference_rejected_logits: Any,
    chosen_divergence_labels: Any,
    rejected_divergence_labels: Any,
    chosen_sft_labels: Any,
    evidence_weight: Any,
    beta: float,
    margin: float,
    sft_weight: float,
) -> tuple[Any, dict[str, Any]]:
    import torch.nn.functional as functional
    policy_chosen = sequence_log_prob(policy_chosen_logits, chosen_divergence_labels)
    policy_rejected = sequence_log_prob(policy_rejected_logits, rejected_divergence_labels)
    reference_chosen = sequence_log_prob(reference_chosen_logits, chosen_divergence_labels)
    reference_rejected = sequence_log_prob(reference_rejected_logits, rejected_divergence_labels)
    advantage = (policy_chosen - reference_chosen) - (policy_rejected - reference_rejected)
    pair_loss = -functional.logsigmoid(beta * advantage - margin)
    normalized_weight = evidence_weight / evidence_weight.mean().clamp_min(1e-6)
    preference_loss = (pair_loss * normalized_weight).mean()
    supervised_loss = sft_loss(policy_chosen_logits, chosen_sft_labels)
    total = preference_loss + sft_weight * supervised_loss
    return total, {
        "preference_loss": preference_loss.detach(),
        "sft_loss": supervised_loss.detach(),
        "causal_margin": advantage.detach().mean(),
        "pair_accuracy": advantage.detach().gt(margin / max(beta, 1e-9)).float().mean(),
    }


class CausalDivergenceTrainerMixin:
    beta: float
    causal_margin: float
    sft_weight: float

    def compute_loss(self, model: Any, inputs: dict[str, Any], return_outputs: bool = False, num_items_in_batch: Any = None) -> Any:
        chosen = model(
            input_ids=inputs["chosen_input_ids"],
            attention_mask=inputs["chosen_attention_mask"],
            use_cache=False,
        )
        rejected = model(
            input_ids=inputs["rejected_input_ids"],
            attention_mask=inputs["rejected_attention_mask"],
            use_cache=False,
        )
        disable_adapter = getattr(model, "disable_adapter", None)
        context = disable_adapter() if callable(disable_adapter) else contextlib.nullcontext()
        with context:
            import torch
            with torch.no_grad():
                reference_chosen = model(
                    input_ids=inputs["chosen_input_ids"],
                    attention_mask=inputs["chosen_attention_mask"],
                    use_cache=False,
                )
                reference_rejected = model(
                    input_ids=inputs["rejected_input_ids"],
                    attention_mask=inputs["rejected_attention_mask"],
                    use_cache=False,
                )
        loss, metrics = causal_divergence_loss(
            policy_chosen_logits=chosen.logits,
            policy_rejected_logits=rejected.logits,
            reference_chosen_logits=reference_chosen.logits,
            reference_rejected_logits=reference_rejected.logits,
            chosen_divergence_labels=inputs["chosen_divergence_labels"],
            rejected_divergence_labels=inputs["rejected_divergence_labels"],
            chosen_sft_labels=inputs["chosen_sft_labels"],
            evidence_weight=inputs["evidence_weight"].to(chosen.logits.device),
            beta=self.beta,
            margin=self.causal_margin,
            sft_weight=self.sft_weight,
        )
        if model.training:
            self.log({key: float(value.cpu()) for key, value in metrics.items()})
        return (loss, {"chosen": chosen, "rejected": rejected}) if return_outputs else loss


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--pairs", required=True)
    parser.add_argument("--pair-receipt", required=True)
    parser.add_argument("--development-pairs")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    pairs_path = pathlib.Path(args.pairs).resolve()
    pair_receipt_path = pathlib.Path(args.pair_receipt).resolve()
    development_path = pathlib.Path(args.development_pairs).resolve() if args.development_pairs else None
    model_dir = pathlib.Path(args.model).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if not model_dir.is_dir():
        raise SystemExit(f"Local student checkpoint is missing: {model_dir}")
    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    cfg = config.get("preference_training") or config.get("training") or {}
    seed = int(config.get("seed", 0))
    pair_receipt = read_json(pair_receipt_path)
    if pair_receipt.get("schema") != SCHEMA_PREFERENCE_DATASET:
        raise SystemExit("Unsupported preference dataset receipt")
    receipt_body = dict(pair_receipt)
    claimed_receipt_digest = receipt_body.pop("receipt_digest", None)
    if sha256_text(stable_json(receipt_body)) != claimed_receipt_digest:
        raise SystemExit("Preference dataset receipt failed integrity verification")
    pair_rows = read_jsonl(pairs_path)
    development_rows = read_jsonl(development_path) if development_path else []
    if not pair_rows:
        raise SystemExit("No preference pairs were supplied")
    expected = sorted(str(item) for item in pair_receipt.get("pair_digests") or [])
    observed = sorted(str(row.get("pair_digest")) for row in [*pair_rows, *development_rows])
    if expected != observed:
        raise SystemExit("Preference rows do not exactly match the bound dataset receipt")

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
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer, TrainingArguments
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before CUDA preference training") from exc
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; CPU fallback is intentionally disabled")
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    output.mkdir(parents=True)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
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
    lora_values = {
        "r": int(cfg.get("lora_rank", 16)),
        "lora_alpha": int(cfg.get("lora_alpha", 32)),
        "lora_dropout": float(cfg.get("lora_dropout", 0.0)),
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": cfg.get("target_modules", "all-linear"),
    }
    model = get_peft_model(model, LoraConfig(**lora_values))
    trainable = [name for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable or any("lora_" not in name for name in trainable):
        raise SystemExit("Preference QLoRA must update only LoRA adapter parameters")
    max_seq_length = int(cfg.get("max_seq_length", 1536))
    tokenized_train = [tokenize_pair(tokenizer, row, max_seq_length) for row in pair_rows]
    tokenized_development = [tokenize_pair(tokenizer, row, max_seq_length) for row in development_rows]
    order = [
        {"pair_id": item["pair_id"], "divergence_target_token": item["divergence_target_token"]}
        for item in tokenized_train
    ]
    training_values = {
        "output_dir": str(output / "checkpoints"),
        "num_train_epochs": float(cfg.get("epochs", 1.0)),
        "learning_rate": float(cfg.get("learning_rate", 2e-4)),
        "per_device_train_batch_size": int(cfg.get("batch_size", 1)),
        "per_device_eval_batch_size": int(cfg.get("batch_size", 1)),
        "gradient_accumulation_steps": int(cfg.get("gradient_accumulation_steps", 8)),
        "gradient_checkpointing": True,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": "paged_adamw_8bit",
        "dataloader_num_workers": 0,
        "logging_steps": int(cfg.get("logging_steps", 1)),
        "save_strategy": "epoch",
        "eval_strategy": "epoch" if tokenized_development else "no",
        "evaluation_strategy": "epoch" if tokenized_development else "no",
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
    trainer_class = type("CausalDivergenceTrainer", (CausalDivergenceTrainerMixin, Trainer), {})
    trainer = trainer_class(
        model=model,
        args=training_args,
        train_dataset=Dataset.from_list(tokenized_train),
        eval_dataset=Dataset.from_list(tokenized_development) if tokenized_development else None,
        data_collator=CausalDivergenceCollator(tokenizer.pad_token_id),
    )
    trainer.beta = float(cfg.get("beta", 0.1))
    trainer.causal_margin = float(cfg.get("causal_margin", 0.2))
    trainer.sft_weight = float(cfg.get("sft_weight", 0.35))
    started = time.monotonic()
    result = trainer.train()
    development_metrics = trainer.evaluate() if tokenized_development else None
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    gpu_index = torch.cuda.current_device()
    gpu = torch.cuda.get_device_properties(gpu_index)
    receipt: dict[str, Any] = {
        "schema": SCHEMA_PREFERENCE_TRAINING,
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "preference_dataset": {
            "train": {"path": str(pairs_path), "sha256": sha256_file(pairs_path), "rows": len(pair_rows)},
            "development": {"path": str(development_path), "sha256": sha256_file(development_path), "rows": len(development_rows)} if development_path else None,
            "receipt": {"path": str(pair_receipt_path), "sha256": sha256_file(pair_receipt_path), "receipt_digest": claimed_receipt_digest},
            "training_order_digest": sha256_text(stable_json(order)),
        },
        "student_checkpoint": {"path": str(model_dir), **directory_identity(model_dir)},
        "adapter": {"path": str(adapter_dir), **directory_identity(adapter_dir, include_files=True)},
        "optimization": {
            "method": "verifier-and-disagreement-anchored-causal-divergence-qlora/v2",
            "quantization": "cuda-nf4-double-quant",
            "epochs": float(cfg.get("epochs", 1.0)),
            "learning_rate": float(cfg.get("learning_rate", 2e-4)),
            "lora": lora_values,
            "trainable_parameter_names": trainable,
            "max_seq_length": max_seq_length,
            "beta": trainer.beta,
            "causal_margin": trainer.causal_margin,
            "sft_weight": trainer.sft_weight,
            "preference_scope": "tokens-at-and-after-first-chosen/rejected-divergence",
            "reference_policy": "same frozen local checkpoint with adapter disabled",
            "evidence_weighting": "verification/disagreement evidence normalized per batch",
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
        "development_metrics": development_metrics,
        "promotion": "not-admitted",
        "claim_boundary": "Real CUDA preference training completed; capability gain still requires base-delta evaluation, fusion/quantization retention, and independent reproduction.",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "training-receipt.json", receipt)
    return receipt
