#!/usr/bin/env python3
"""CUDA-only Verifier-Anchored Causal-Divergence QLoRA for Archie.

This is an executable neural objective, not a routing or promotion scaffold.
For each independently verified failed->repair pair it:

1. preserves the shared target prefix;
2. applies SFT to the verified repair continuation;
3. applies a reference-anchored DPO margin only from the first divergent token;
4. weights the pair by bound verification evidence;
5. updates only QLoRA adapter parameters on a local 4-bit checkpoint.

The resulting adapter remains not admitted until hidden evaluation, independent
authority review, clean reproduction, and device admission succeed.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import pathlib
import platform
import random
import sys
import time
from dataclasses import dataclass
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import (  # type: ignore
    artifact_manifest,
    directory_identity,
    package_versions,
    read_json,
    read_jsonl,
    require_profile,
    sha256,
    stable,
    supported_kwargs,
    tokenizer_identity,
)

SCHEMA = "archie-neural-causal-divergence-training-receipt/v1"
METHOD = "verifier-anchored-causal-divergence-qlora/v1"
PAIR_SCHEMA = "archie-causal-divergence-pair/v1"


def prompt_text(tokenizer: Any, row: dict[str, Any]) -> str:
    instruction = str(row.get("instruction") or "").strip()
    if not instruction:
        raise SystemExit(f"Preference pair {row.get('pair_id', '<unknown>')} has no instruction.")
    context = row.get("compact_context")
    user = instruction if context in (None, {}, []) else f"{instruction}\n\nContext:\n{stable(context)}"
    messages = [
        {"role": "system", "content": "You are Archie. Produce typed, permission-aware plans grounded in verifiable evidence."},
        {"role": "user", "content": user},
    ]
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages) + "\n<assistant>\n"


def common_prefix_length(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def tokenize_pair(tokenizer: Any, row: dict[str, Any], max_seq_length: int) -> dict[str, Any]:
    if row.get("schema") != PAIR_SCHEMA:
        raise SystemExit(f"Unsupported preference pair schema for {row.get('pair_id', '<unknown>')}.")
    chosen = str(row.get("chosen_target") or "").strip()
    rejected = str(row.get("rejected_target") or "").strip()
    if not chosen or not rejected or chosen == rejected:
        raise SystemExit(f"Preference pair {row.get('pair_id')} must contain distinct chosen and rejected targets.")
    prompt_ids = tokenizer(prompt_text(tokenizer, row), add_special_tokens=False)["input_ids"]
    chosen_ids = tokenizer(chosen, add_special_tokens=False)["input_ids"]
    rejected_ids = tokenizer(rejected, add_special_tokens=False)["input_ids"]
    eos = [tokenizer.eos_token_id] if tokenizer.eos_token_id is not None else []
    divergence = common_prefix_length(chosen_ids, rejected_ids)
    if divergence >= min(len(chosen_ids), len(rejected_ids)):
        raise SystemExit(f"Preference pair {row.get('pair_id')} has no causal divergence before one target ends.")

    def build(target_ids: list[int]) -> tuple[list[int], list[int], list[int]]:
        available = max_seq_length - len(prompt_ids)
        if available <= 1:
            raise SystemExit(f"Preference prompt {row.get('pair_id')} consumes the full sequence budget.")
        target = (target_ids + eos)[:available]
        input_ids = (prompt_ids + target)[:max_seq_length]
        sft_labels = [-100] * len(prompt_ids) + target
        divergence_labels = [-100] * (len(prompt_ids) + min(divergence, len(target))) + target[min(divergence, len(target)):]
        return input_ids, sft_labels[:len(input_ids)], divergence_labels[:len(input_ids)]

    chosen_input_ids, chosen_sft_labels, chosen_divergence_labels = build(chosen_ids)
    rejected_input_ids, _, rejected_divergence_labels = build(rejected_ids)
    if not any(item != -100 for item in chosen_divergence_labels) or not any(item != -100 for item in rejected_divergence_labels):
        raise SystemExit(f"Preference pair {row.get('pair_id')} was truncated before its divergence supervision.")
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
    preference = (pair_loss * normalized_weight).mean()
    supervised = sft_loss(policy_chosen_logits, chosen_sft_labels)
    total = preference + sft_weight * supervised
    metrics = {
        "preference_loss": preference.detach(),
        "sft_loss": supervised.detach(),
        "causal_margin": advantage.detach().mean(),
        "pair_accuracy": advantage.detach().gt(margin / max(beta, 1e-9)).float().mean(),
    }
    return total, metrics


class CausalDivergenceTrainerMixin:
    beta: float
    causal_margin: float
    sft_weight: float

    def compute_loss(self, model: Any, inputs: dict[str, Any], return_outputs: bool = False, num_items_in_batch: Any = None) -> Any:
        chosen = model(input_ids=inputs["chosen_input_ids"], attention_mask=inputs["chosen_attention_mask"], use_cache=False)
        rejected = model(input_ids=inputs["rejected_input_ids"], attention_mask=inputs["rejected_attention_mask"], use_cache=False)
        disable_adapter = getattr(model, "disable_adapter", None)
        context = disable_adapter() if callable(disable_adapter) else contextlib.nullcontext()
        with context:
            import torch
            with torch.no_grad():
                reference_chosen = model(input_ids=inputs["chosen_input_ids"], attention_mask=inputs["chosen_attention_mask"], use_cache=False)
                reference_rejected = model(input_ids=inputs["rejected_input_ids"], attention_mask=inputs["rejected_attention_mask"], use_cache=False)
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--preference-data", required=True)
    parser.add_argument("--preference-receipt", required=True)
    parser.add_argument("--preference-eval-data")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-dir")
    parser.add_argument("--max-seq-length", type=int, default=1536)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--beta", type=float, default=0.1)
    parser.add_argument("--causal-margin", type=float, default=0.2)
    parser.add_argument("--sft-weight", type=float, default=0.35)
    args = parser.parse_args()

    profile_path = pathlib.Path(args.profile).resolve()
    workspace = pathlib.Path(args.workspace).resolve()
    preference_path = pathlib.Path(args.preference_data).resolve()
    preference_receipt_path = pathlib.Path(args.preference_receipt).resolve()
    preference_eval_path = pathlib.Path(args.preference_eval_data).resolve() if args.preference_eval_data else None
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
    preference_receipt = read_json(preference_receipt_path)
    if preference_receipt.get("schema") != "archie-causal-divergence-dataset-receipt/v1":
        raise SystemExit("Unsupported causal-divergence dataset receipt.")
    receipt_body = dict(preference_receipt)
    claimed_receipt_digest = receipt_body.pop("receipt_digest", None)
    if hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest() != claimed_receipt_digest:
        raise SystemExit("Causal-divergence dataset receipt failed integrity verification.")

    pair_rows = read_jsonl(preference_path, required=True)
    eval_rows = read_jsonl(preference_eval_path) if preference_eval_path else []
    if not pair_rows:
        raise SystemExit("No causal-divergence preference pairs were supplied.")
    expected_pair_digests = sorted(preference_receipt.get("pair_digests") or [])
    observed_pair_digests = sorted(str(row.get("pair_digest") or "") for row in pair_rows + eval_rows)
    if expected_pair_digests != observed_pair_digests:
        raise SystemExit("Preference rows do not exactly match the bound dataset receipt.")

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer, TrainingArguments
    except Exception as exc:
        raise SystemExit("Pinned CUDA QLoRA dependencies are not installed in this environment.") from exc
    if not torch.cuda.is_available():
        raise SystemExit("Archie causal-divergence QLoRA requires a supported local CUDA GPU. Refusing CPU fallback.")

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
        raise SystemExit("Student checkpoint did not load in 4-bit mode; refusing a false QLoRA receipt.")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.config.use_cache = False
    lora_values = {
        "r": int(cfg["lora_rank"]),
        "lora_alpha": int(cfg["lora_alpha"]),
        "lora_dropout": float(cfg.get("lora_dropout", 0.0)),
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": cfg.get("target_modules", "all-linear"),
    }
    model = get_peft_model(model, LoraConfig(**lora_values))
    trainable_parameters = [name for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable_parameters or any("lora_" not in name for name in trainable_parameters):
        raise SystemExit("Causal-divergence QLoRA must update only LoRA adapter parameters.")

    tokenized_train = [tokenize_pair(tokenizer, row, args.max_seq_length) for row in pair_rows]
    tokenized_eval = [tokenize_pair(tokenizer, row, args.max_seq_length) for row in eval_rows]
    order = [{"pair_id": item["pair_id"], "divergence_target_token": item["divergence_target_token"]} for item in tokenized_train]
    training_order_digest = hashlib.sha256(stable(order).encode("utf-8")).hexdigest()

    training_values = {
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
        "eval_strategy": "epoch" if tokenized_eval else "no",
        "evaluation_strategy": "epoch" if tokenized_eval else "no",
        "seed": seed,
        "data_seed": seed,
        "full_determinism": True,
        "tf32": False,
        "report_to": [],
        "remove_unused_columns": False,
        "bf16": False,
        "fp16": True,
    }
    training_args = TrainingArguments(**supported_kwargs(TrainingArguments.__init__, training_values))
    trainer_class = type("CausalDivergenceTrainer", (CausalDivergenceTrainerMixin, Trainer), {})
    trainer = trainer_class(
        model=model,
        args=training_args,
        train_dataset=Dataset.from_list(tokenized_train),
        eval_dataset=Dataset.from_list(tokenized_eval) if tokenized_eval else None,
        data_collator=CausalDivergenceCollator(tokenizer.pad_token_id),
    )
    trainer.beta = args.beta
    trainer.causal_margin = args.causal_margin
    trainer.sft_weight = args.sft_weight
    result = trainer.train()
    evaluation = trainer.evaluate() if tokenized_eval else None
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)

    gpu_index = torch.cuda.current_device()
    gpu_properties = torch.cuda.get_device_properties(gpu_index)
    receipt = {
        "schema": SCHEMA,
        "method": METHOD,
        "profile": {"id": profile.get("id"), "sha256": sha256(profile_path)},
        "training_plan": {"sha256": sha256(plan_path), "plan_digest": plan.get("plan_digest")},
        "preference_dataset": {
            "train": {"path": str(preference_path), "sha256": sha256(preference_path), "rows": len(pair_rows)},
            "development": {"path": str(preference_eval_path), "sha256": sha256(preference_eval_path), "rows": len(eval_rows)} if preference_eval_path else None,
            "receipt": {"path": str(preference_receipt_path), "sha256": sha256(preference_receipt_path), "receipt_digest": claimed_receipt_digest},
            "training_order_digest": training_order_digest,
        },
        "student_checkpoint": {
            "path": str(model_dir),
            "revision": profile.get("student", {}).get("revision"),
            **checkpoint_identity,
            "tokenizer": checkpoint_tokenizer_identity,
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packages": package_versions(["torch", "transformers", "datasets", "peft", "bitsandbytes", "accelerate"]),
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
            "method": METHOD,
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
            "beta": args.beta,
            "causal_margin": args.causal_margin,
            "sft_weight": args.sft_weight,
            "preference_scope": "tokens-at-and-after-first-chosen/rejected-divergence",
            "reference_policy": "same frozen local checkpoint with LoRA adapter disabled",
            "evidence_weighting": "bound independent verification count, normalized per batch",
        },
        "train_metrics": result.metrics,
        "development_metrics": evaluation,
        "artifacts": artifact_manifest(adapter_dir),
        "promotion": "not-admitted",
        "novelty_boundary": "This is a repository-new experimental neural objective combining verifier-bound repair lineage, causal-divergence masking, frozen-base reference anchoring, and evidence-weighted QLoRA. It is not a claim of globally unique prior art or improved capability without evaluation.",
        "claim_boundary": "Real CUDA QLoRA gradient training completed under the causal-divergence objective. Hidden capability, safety, authority, reproduction, and production promotion remain unproven.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable(receipt).encode("utf-8")).hexdigest()
    (output / "training-receipt.json").write_text(__import__("json").dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(__import__("json").dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
