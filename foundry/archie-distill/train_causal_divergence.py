#!/usr/bin/env python3
"""CUDA-only, verifier-bound, token-budgeted causal-divergence QLoRA."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import math
import os
import pathlib
import platform
import random
import sys
import time
from collections import defaultdict
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
REFERENCE_OBJECTIVE = "reference-anchored-dpo-margin/v1"
POLICY_ONLY_OBJECTIVE = "policy-only-causal-margin/v1"
BUDGET_METHOD = "lineage-atomic-information-per-token/v1"


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
    index = 0
    while index < min(len(left), len(right)) and left[index] == right[index]:
        index += 1
    return index


def tokenize_pair(
    tokenizer: Any,
    row: dict[str, Any],
    max_seq_length: int,
    max_post_divergence_tokens: int | None = None,
) -> dict[str, Any]:
    if row.get("schema") != PAIR_SCHEMA:
        raise SystemExit(f"Unsupported preference pair schema for {row.get('pair_id', '<unknown>')}.")
    chosen = str(row.get("chosen_target") or "").strip()
    rejected = str(row.get("rejected_target") or "").strip()
    if not chosen or not rejected or chosen == rejected:
        raise SystemExit(f"Preference pair {row.get('pair_id')} must contain distinct chosen and rejected targets.")
    if max_seq_length < 8:
        raise SystemExit("max_seq_length must be at least 8.")
    if max_post_divergence_tokens is not None and max_post_divergence_tokens < 1:
        raise SystemExit("max_post_divergence_tokens must be positive when supplied.")

    prompt_ids = tokenizer(prompt_text(tokenizer, row), add_special_tokens=False)["input_ids"]
    chosen_ids = tokenizer(chosen, add_special_tokens=False)["input_ids"]
    rejected_ids = tokenizer(rejected, add_special_tokens=False)["input_ids"]
    divergence = common_prefix_length(chosen_ids, rejected_ids)
    if divergence >= min(len(chosen_ids), len(rejected_ids)):
        raise SystemExit(f"Preference pair {row.get('pair_id')} has no causal divergence before one target ends.")
    if max_post_divergence_tokens is not None:
        chosen_ids = chosen_ids[:divergence + max_post_divergence_tokens]
        rejected_ids = rejected_ids[:divergence + max_post_divergence_tokens]
    eos = [tokenizer.eos_token_id] if tokenizer.eos_token_id is not None else []

    def build(target_ids: list[int]) -> tuple[list[int], list[int], list[int]]:
        available = max_seq_length - len(prompt_ids)
        if available <= 1:
            raise SystemExit(f"Preference prompt {row.get('pair_id')} consumes the full sequence budget.")
        target = (target_ids + eos)[:available]
        input_ids = prompt_ids + target
        split = len(prompt_ids) + min(divergence, len(target))
        return input_ids, [-100] * len(prompt_ids) + target, [-100] * split + target[min(divergence, len(target)):]

    chosen_ids_out, chosen_sft, chosen_div = build(chosen_ids)
    rejected_ids_out, _, rejected_div = build(rejected_ids)
    if not any(value != -100 for value in chosen_div) or not any(value != -100 for value in rejected_div):
        raise SystemExit(f"Preference pair {row.get('pair_id')} was truncated before its divergence supervision.")
    return {
        "pair_id": row.get("pair_id"),
        "group_id": row.get("group_id") or f"pair:{row.get('pair_id')}",
        "chosen_input_ids": chosen_ids_out,
        "chosen_sft_labels": chosen_sft,
        "chosen_divergence_labels": chosen_div,
        "rejected_input_ids": rejected_ids_out,
        "rejected_divergence_labels": rejected_div,
        "evidence_weight": max(0.25, min(4.0, float(row.get("evidence_weight", 1.0)))),
        "divergence_target_token": divergence,
        "information_tokens": sum(value != -100 for value in chosen_div + rejected_div),
        "token_cost": len(chosen_ids_out) + len(rejected_ids_out),
    }


def select_budgeted_pairs(
    tokenized: list[dict[str, Any]], *, fraction: float, minimum_pairs: int, seed: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not tokenized:
        raise SystemExit("Token budgeting requires at least one pair.")
    if not 0 < fraction <= 1:
        raise SystemExit("token_budget_fraction must be in (0,1].")
    if minimum_pairs < 1:
        raise SystemExit("minimum_train_pairs must be positive.")
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in tokenized:
        grouped[str(item["group_id"])].append(item)
    groups = []
    for group_id, items in grouped.items():
        cost = sum(int(item["token_cost"]) for item in items)
        information = sum(int(item["information_tokens"]) for item in items)
        evidence = sum(float(item["evidence_weight"]) for item in items)
        groups.append({
            "group_id": group_id,
            "items": sorted(items, key=lambda item: str(item["pair_id"])),
            "token_cost": cost,
            "evidence_weight": evidence,
            "utility": evidence * math.log2(2.0 + information) / max(1, cost),
            "tie": hashlib.sha256(f"{seed}:{group_id}".encode()).hexdigest(),
        })
    groups.sort(key=lambda item: (-item["utility"], -item["evidence_weight"], item["tie"]))
    total_cost = sum(int(group["token_cost"]) for group in groups)
    target_cost = max(1, math.ceil(total_cost * fraction))
    selected_groups, selected_cost, selected_pairs = [], 0, 0
    for group in groups:
        if selected_cost >= target_cost and selected_pairs >= min(minimum_pairs, len(tokenized)):
            break
        selected_groups.append(group)
        selected_cost += int(group["token_cost"])
        selected_pairs += len(group["items"])
    selected_ids = {str(item["pair_id"]) for group in selected_groups for item in group["items"]}
    selected = sorted((item for item in tokenized if str(item["pair_id"]) in selected_ids), key=lambda item: str(item["pair_id"]))
    receipt = {
        "method": BUDGET_METHOD,
        "requested_fraction": fraction,
        "realized_fraction": selected_cost / max(1, total_cost),
        "total_token_cost": total_cost,
        "target_token_cost": target_cost,
        "selected_token_cost": selected_cost,
        "total_pairs": len(tokenized),
        "selected_pairs": len(selected),
        "selected_group_ids": sorted(group["group_id"] for group in selected_groups),
        "selected_pair_ids": [str(item["pair_id"]) for item in selected],
        "omitted_pair_ids": sorted(str(item["pair_id"]) for item in tokenized if str(item["pair_id"]) not in selected_ids),
        "lineage_atomic": True,
        "ranking": "evidence_weight * log2(2 + divergence_information_tokens) / model_forward_tokens",
    }
    return selected, receipt


@dataclass
class CausalDivergenceCollator:
    pad_token_id: int

    @staticmethod
    def _pad(rows: list[list[int]], value: int, width: int) -> Any:
        import torch
        return torch.tensor([row + [value] * (width - len(row)) for row in rows], dtype=torch.long)

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        import torch
        chosen = [item["chosen_input_ids"] for item in features]
        rejected = [item["rejected_input_ids"] for item in features]
        width = max(*(len(row) for row in chosen), *(len(row) for row in rejected))
        return {
            "chosen_input_ids": self._pad(chosen, self.pad_token_id, width),
            "chosen_attention_mask": self._pad([[1] * len(row) for row in chosen], 0, width),
            "chosen_sft_labels": self._pad([item["chosen_sft_labels"] for item in features], -100, width),
            "chosen_divergence_labels": self._pad([item["chosen_divergence_labels"] for item in features], -100, width),
            "rejected_input_ids": self._pad(rejected, self.pad_token_id, width),
            "rejected_attention_mask": self._pad([[1] * len(row) for row in rejected], 0, width),
            "rejected_divergence_labels": self._pad([item["rejected_divergence_labels"] for item in features], -100, width),
            "evidence_weight": torch.tensor([item["evidence_weight"] for item in features], dtype=torch.float32),
        }


def sequence_log_prob(logits: Any, labels: Any) -> Any:
    import torch
    import torch.nn.functional as functional
    shifted_logits, shifted_labels = logits[:, :-1, :].float(), labels[:, 1:]
    mask = shifted_labels.ne(-100)
    safe_labels = shifted_labels.masked_fill(~mask, 0)
    values = functional.log_softmax(shifted_logits, dim=-1).gather(-1, safe_labels.unsqueeze(-1)).squeeze(-1) * mask
    return values.sum(dim=-1) / torch.sqrt(mask.sum(dim=-1).clamp_min(1).float())


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
    objective_mode: str = REFERENCE_OBJECTIVE,
) -> tuple[Any, dict[str, Any]]:
    import torch.nn.functional as functional
    policy_chosen = sequence_log_prob(policy_chosen_logits, chosen_divergence_labels)
    policy_rejected = sequence_log_prob(policy_rejected_logits, rejected_divergence_labels)
    if objective_mode == REFERENCE_OBJECTIVE:
        if reference_chosen_logits is None or reference_rejected_logits is None:
            raise ValueError("Reference logits are required for the reference-anchored objective.")
        advantage = (
            policy_chosen - sequence_log_prob(reference_chosen_logits, chosen_divergence_labels)
            - policy_rejected + sequence_log_prob(reference_rejected_logits, rejected_divergence_labels)
        )
    elif objective_mode == POLICY_ONLY_OBJECTIVE:
        advantage = policy_chosen - policy_rejected
    else:
        raise ValueError(f"Unsupported causal-divergence objective: {objective_mode}")
    normalized_weight = evidence_weight / evidence_weight.mean().clamp_min(1e-6)
    preference = (-functional.logsigmoid(beta * advantage - margin) * normalized_weight).mean()
    supervised = sft_loss(policy_chosen_logits, chosen_sft_labels)
    return preference + sft_weight * supervised, {
        "preference_loss": preference.detach(),
        "sft_loss": supervised.detach(),
        "causal_margin": advantage.detach().mean(),
        "pair_accuracy": advantage.detach().gt(margin / max(beta, 1e-9)).float().mean(),
    }


class CausalDivergenceTrainerMixin:
    beta: float
    causal_margin: float
    sft_weight: float
    objective_mode: str

    def compute_loss(self, model: Any, inputs: dict[str, Any], return_outputs: bool = False, num_items_in_batch: Any = None) -> Any:
        import torch
        batch_size = inputs["chosen_input_ids"].shape[0]
        ids = torch.cat([inputs["chosen_input_ids"], inputs["rejected_input_ids"]], dim=0)
        mask = torch.cat([inputs["chosen_attention_mask"], inputs["rejected_attention_mask"]], dim=0)
        policy = model(input_ids=ids, attention_mask=mask, use_cache=False).logits
        reference_chosen = reference_rejected = None
        if self.objective_mode == REFERENCE_OBJECTIVE:
            disable_adapter = getattr(model, "disable_adapter", None)
            with (disable_adapter() if callable(disable_adapter) else contextlib.nullcontext()), torch.no_grad():
                reference = model(input_ids=ids, attention_mask=mask, use_cache=False).logits
            reference_chosen, reference_rejected = reference[:batch_size], reference[batch_size:]
        chosen, rejected = policy[:batch_size], policy[batch_size:]
        loss, metrics = causal_divergence_loss(
            policy_chosen_logits=chosen,
            policy_rejected_logits=rejected,
            reference_chosen_logits=reference_chosen,
            reference_rejected_logits=reference_rejected,
            chosen_divergence_labels=inputs["chosen_divergence_labels"],
            rejected_divergence_labels=inputs["rejected_divergence_labels"],
            chosen_sft_labels=inputs["chosen_sft_labels"],
            evidence_weight=inputs["evidence_weight"].to(chosen.device),
            beta=self.beta,
            margin=self.causal_margin,
            sft_weight=self.sft_weight,
            objective_mode=self.objective_mode,
        )
        if model.training:
            self.log({key: float(value.cpu()) for key, value in metrics.items()})
        return (loss, {"chosen_logits": chosen, "rejected_logits": rejected}) if return_outputs else loss


def verify_dataset(receipt_path: pathlib.Path, train_rows: list[dict[str, Any]], eval_rows: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    receipt = read_json(receipt_path)
    if receipt.get("schema") != "archie-causal-divergence-dataset-receipt/v1":
        raise SystemExit("Unsupported causal-divergence dataset receipt.")
    body = dict(receipt)
    claimed = body.pop("receipt_digest", None)
    if hashlib.sha256(stable(body).encode()).hexdigest() != claimed:
        raise SystemExit("Causal-divergence dataset receipt failed integrity verification.")
    expected = sorted(receipt.get("pair_digests") or [])
    observed = sorted(str(row.get("pair_digest") or "") for row in train_rows + eval_rows)
    if expected != observed:
        raise SystemExit("Preference rows do not exactly match the bound dataset receipt.")
    return receipt, str(claimed)


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

    profile_path, workspace = pathlib.Path(args.profile).resolve(), pathlib.Path(args.workspace).resolve()
    train_path, receipt_path = pathlib.Path(args.preference_data).resolve(), pathlib.Path(args.preference_receipt).resolve()
    eval_path = pathlib.Path(args.preference_eval_data).resolve() if args.preference_eval_data else None
    output = pathlib.Path(args.output).resolve()
    profile, plan = read_json(profile_path), read_json(workspace / "training-plan.json")
    cfg, seed = require_profile(profile), int(require_profile(profile)["seed"])
    if plan.get("schema") != "archie-training-plan/v1":
        raise SystemExit("Workspace does not contain an Archie training plan v1.")
    train_rows, eval_rows = read_jsonl(train_path, required=True), read_jsonl(eval_path) if eval_path else []
    if not train_rows:
        raise SystemExit("No causal-divergence preference pairs were supplied.")
    _, receipt_digest = verify_dataset(receipt_path, train_rows, eval_rows)

    for name, value in {
        "PYTHONHASHSEED": str(seed),
        "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
        "TOKENIZERS_PARALLELISM": "false",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
    }.items():
        os.environ[name] = value
    random.seed(seed)
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
    checkpoint_identity, checkpoint_tokenizer_identity = directory_identity(model_dir), tokenizer_identity(model_dir)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization_values = {
        "load_in_4bit": True,
        "bnb_4bit_quant_type": "nf4",
        "bnb_4bit_use_double_quant": True,
        "bnb_4bit_compute_dtype": "float16",
    }
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
        ),
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    if not getattr(model, "is_loaded_in_4bit", False):
        raise SystemExit("Student checkpoint did not load in 4-bit mode; refusing a false QLoRA receipt.")
    gradient_checkpointing = bool(cfg.get("gradient_checkpointing", False))
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=gradient_checkpointing)
    model.config.use_cache = False
    lora_values = {
        "r": int(cfg["lora_rank"]),
        "lora_alpha": int(cfg["lora_alpha"]),
        "lora_dropout": float(cfg.get("lora_dropout", 0.0)),
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": cfg.get("target_modules", "all-linear"),
        "use_rslora": bool(cfg.get("use_rslora", False)),
    }
    model = get_peft_model(model, LoraConfig(**lora_values))
    trainable_parameters = [name for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable_parameters or any("lora_" not in name for name in trainable_parameters):
        raise SystemExit("Causal-divergence QLoRA must update only LoRA adapter parameters.")

    max_length = min(args.max_seq_length, int(cfg.get("max_seq_length", args.max_seq_length)))
    tail = int(cfg.get("max_post_divergence_tokens", 0)) or None
    all_tokens = [tokenize_pair(tokenizer, row, max_length, tail) for row in train_rows]
    train_tokens, budget = select_budgeted_pairs(
        all_tokens,
        fraction=float(cfg.get("token_budget_fraction", 1.0)),
        minimum_pairs=int(cfg.get("minimum_train_pairs", 1)),
        seed=seed,
    )
    inline_eval = bool(cfg.get("inline_evaluation", True))
    eval_tokens = [tokenize_pair(tokenizer, row, max_length, tail) for row in eval_rows] if inline_eval else []
    objective = str(cfg.get("objective", REFERENCE_OBJECTIVE))
    if objective not in {REFERENCE_OBJECTIVE, POLICY_ONLY_OBJECTIVE}:
        raise SystemExit(f"Unsupported profile training.objective: {objective}")
    baseline_tokens = 2 * sum(int(item["token_cost"]) for item in all_tokens)
    configured_tokens = sum(int(item["token_cost"]) for item in train_tokens) * (2 if objective == REFERENCE_OBJECTIVE else 1)
    order = [{"pair_id": item["pair_id"], "divergence_target_token": item["divergence_target_token"]} for item in train_tokens]

    values = {
        "output_dir": str(output / "checkpoints"),
        "num_train_epochs": float(cfg["epochs"]),
        "learning_rate": float(cfg["learning_rate"]),
        "per_device_train_batch_size": args.batch_size,
        "per_device_eval_batch_size": args.batch_size,
        "gradient_accumulation_steps": args.gradient_accumulation_steps,
        "gradient_checkpointing": gradient_checkpointing,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": "paged_adamw_8bit",
        "dataloader_num_workers": 0,
        "logging_steps": 1,
        "save_strategy": "epoch",
        "eval_strategy": "epoch" if eval_tokens else "no",
        "evaluation_strategy": "epoch" if eval_tokens else "no",
        "seed": seed,
        "data_seed": seed,
        "full_determinism": True,
        "tf32": False,
        "report_to": [],
        "remove_unused_columns": False,
        "bf16": False,
        "fp16": True,
    }
    trainer_class = type("CausalDivergenceTrainer", (CausalDivergenceTrainerMixin, Trainer), {})
    trainer = trainer_class(
        model=model,
        args=TrainingArguments(**supported_kwargs(TrainingArguments.__init__, values)),
        train_dataset=Dataset.from_list(train_tokens),
        eval_dataset=Dataset.from_list(eval_tokens) if eval_tokens else None,
        data_collator=CausalDivergenceCollator(tokenizer.pad_token_id),
    )
    trainer.beta, trainer.causal_margin, trainer.sft_weight, trainer.objective_mode = args.beta, args.causal_margin, args.sft_weight, objective
    result = trainer.train()
    evaluation = trainer.evaluate() if eval_tokens else None
    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)

    gpu_index, gpu = torch.cuda.current_device(), torch.cuda.get_device_properties(torch.cuda.current_device())
    receipt = {
        "schema": SCHEMA,
        "method": METHOD,
        "profile": {"id": profile.get("id"), "sha256": sha256(profile_path)},
        "training_plan": {"sha256": sha256(workspace / "training-plan.json"), "plan_digest": plan.get("plan_digest")},
        "preference_dataset": {
            "train": {"path": str(train_path), "sha256": sha256(train_path), "rows": len(train_rows)},
            "development": {"path": str(eval_path), "sha256": sha256(eval_path), "rows": len(eval_rows)} if eval_path else None,
            "receipt": {"path": str(receipt_path), "sha256": sha256(receipt_path), "receipt_digest": receipt_digest},
            "training_order_digest": hashlib.sha256(stable(order).encode()).hexdigest(),
            "token_budget": budget,
        },
        "student_checkpoint": {"path": str(model_dir), "revision": profile.get("student", {}).get("revision"), **checkpoint_identity, "tokenizer": checkpoint_tokenizer_identity},
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packages": package_versions(["torch", "transformers", "datasets", "peft", "bitsandbytes", "accelerate"]),
            "cuda": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "gpu": {"index": gpu_index, "name": torch.cuda.get_device_name(gpu_index), "capability": list(torch.cuda.get_device_capability(gpu_index)), "total_memory_bytes": gpu.total_memory},
        },
        "optimization": {
            "method": METHOD,
            "objective": objective,
            "quantization": quantization_values,
            "optimizer": "paged_adamw_8bit",
            "seed": seed,
            "epochs": float(cfg["epochs"]),
            "learning_rate": float(cfg["learning_rate"]),
            "lora": lora_values,
            "trainable_parameter_names": trainable_parameters,
            "max_seq_length": max_length,
            "max_post_divergence_tokens": tail,
            "batch_size": args.batch_size,
            "gradient_accumulation_steps": args.gradient_accumulation_steps,
            "gradient_checkpointing": gradient_checkpointing,
            "inline_evaluation": inline_eval,
            "beta": args.beta,
            "causal_margin": args.causal_margin,
            "sft_weight": args.sft_weight,
            "preference_scope": "tokens-at-and-after-first-chosen/rejected-divergence",
            "reference_policy": "same frozen local checkpoint with LoRA adapter disabled" if objective == REFERENCE_OBJECTIVE else "external frozen-base verifier; no reference forwards inside gradient training",
            "forward_token_work_estimate": {
                "reference_anchored_full_dataset": baseline_tokens,
                "configured_training": configured_tokens,
                "estimated_reduction_fraction": 1.0 - configured_tokens / max(1, baseline_tokens),
                "excludes_backward-pass and verifier cost": True,
            },
        },
        "train_metrics": result.metrics,
        "development_metrics": evaluation,
        "artifacts": artifact_manifest(adapter_dir),
        "promotion": "not-admitted",
        "novelty_boundary": "This repository method combines verifier-bound repair lineages, deterministic information-per-token budgeting, bounded causal tails, a policy-only causal margin option, and rank-stabilized QLoRA. It is not a claim of globally unique prior art or improved capability without evaluation.",
        "claim_boundary": "Real CUDA QLoRA gradient training completed under the recorded objective. Changed tensors, hidden capability, fused-model quality, quantization retention, independent reproduction, and production promotion remain separately gated.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable(receipt).encode()).hexdigest()
    (output / "training-receipt.json").write_text(__import__("json").dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(__import__("json").dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
