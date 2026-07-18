#!/usr/bin/env python3
"""Prove a segmented LoRA adapter changed and compare it with the frozen base.

The verifier reconstructs the deterministic pre-training LoRA initialization,
compares every saved adapter tensor byte-for-byte, loads the trained state into
the same NF4 base, and evaluates the global held-out causal pairs with the
adapter both disabled and enabled. It refuses CPU fallback and never promotes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import random
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import directory_identity, package_versions, read_json, read_jsonl, require_profile, sha256, stable, tokenizer_identity  # type: ignore
from train_causal_divergence import CausalDivergenceCollator, sequence_log_prob, tokenize_pair  # type: ignore

SCHEMA = "archie-segment-adapter-verification-receipt/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"
TRAINING_METHOD = "verifier-anchored-causal-divergence-qlora/v1"


def state_digest(tensor: Any) -> str:
    raw = tensor.detach().cpu().contiguous().view(__import__("torch").uint8).numpy().tobytes()
    return hashlib.sha256(raw).hexdigest()


def verify_receipt(path: pathlib.Path, expected_schema: str) -> dict[str, Any]:
    value = read_json(path)
    if value.get("schema") != expected_schema:
        raise SystemExit(f"Unexpected receipt schema in {path}.")
    body = dict(value)
    claimed = body.pop("receipt_digest", None)
    if not claimed or hashlib.sha256(stable(body).encode("utf-8")).hexdigest() != claimed:
        raise SystemExit(f"Receipt integrity failed for {path}.")
    return value


def adapter_change_proof(initial: dict[str, Any], final: dict[str, Any]) -> dict[str, Any]:
    import torch

    if set(initial) != set(final):
        missing = sorted(set(initial) - set(final))
        extra = sorted(set(final) - set(initial))
        raise SystemExit(f"Adapter tensor keys differ from deterministic initialization; missing={missing[:4]}, extra={extra[:4]}.")
    tensors = []
    changed = 0
    total_l2 = 0.0
    maximum = 0.0
    for name in sorted(initial):
        before = initial[name].detach().cpu().contiguous()
        after = final[name].detach().cpu().contiguous()
        if tuple(before.shape) != tuple(after.shape):
            raise SystemExit(f"Adapter tensor shape changed unexpectedly for {name}.")
        delta = after.float() - before.float()
        l2 = float(torch.linalg.vector_norm(delta).item())
        max_abs = float(delta.abs().max().item()) if delta.numel() else 0.0
        before_digest = state_digest(before)
        after_digest = state_digest(after)
        did_change = before_digest != after_digest and max_abs > 0.0
        changed += int(did_change)
        total_l2 += l2
        maximum = max(maximum, max_abs)
        tensors.append({
            "name": name,
            "shape": list(after.shape),
            "dtype": str(after.dtype).replace("torch.", ""),
            "initial_sha256": before_digest,
            "trained_sha256": after_digest,
            "changed": did_change,
            "l2_delta": l2,
            "max_abs_delta": max_abs,
        })
    if not tensors or changed < 1 or total_l2 <= 0.0 or maximum <= 0.0:
        raise SystemExit("No LoRA adapter tensor changed from deterministic initialization.")
    return {
        "reconstructed_initialization": True,
        "tensor_count": len(tensors),
        "changed_tensor_count": changed,
        "changed_fraction": changed / len(tensors),
        "aggregate_l2_delta": total_l2,
        "maximum_absolute_delta": maximum,
        "tensors": tensors,
    }


def evaluate_policy(model: Any, rows: list[dict[str, Any]], tokenizer: Any, max_seq_length: int, *, adapter_enabled: bool) -> dict[str, Any]:
    import contextlib
    import torch

    collator = CausalDivergenceCollator(tokenizer.pad_token_id)
    totals = {
        "weight": 0.0,
        "chosen_log_probability": 0.0,
        "rejected_log_probability": 0.0,
        "pair_margin": 0.0,
        "pair_accuracy": 0.0,
        "chosen_negative_log_probability": 0.0,
    }
    cases = []
    model.eval()
    context = contextlib.nullcontext() if adapter_enabled else model.disable_adapter()
    with context, torch.no_grad():
        for row in rows:
            tokenized = tokenize_pair(tokenizer, row, max_seq_length)
            batch = collator([tokenized])
            device = torch.device("cuda", torch.cuda.current_device())
            batch = {key: value.to(device) if hasattr(value, "to") else value for key, value in batch.items()}
            chosen = model(
                input_ids=batch["chosen_input_ids"],
                attention_mask=batch["chosen_attention_mask"],
                use_cache=False,
            )
            rejected = model(
                input_ids=batch["rejected_input_ids"],
                attention_mask=batch["rejected_attention_mask"],
                use_cache=False,
            )
            chosen_logp = float(sequence_log_prob(chosen.logits, batch["chosen_divergence_labels"])[0].item())
            rejected_logp = float(sequence_log_prob(rejected.logits, batch["rejected_divergence_labels"])[0].item())
            chosen_full_logp = float(sequence_log_prob(chosen.logits, batch["chosen_sft_labels"])[0].item())
            margin = chosen_logp - rejected_logp
            weight = float(row.get("evidence_weight", 1.0))
            totals["weight"] += weight
            totals["chosen_log_probability"] += weight * chosen_logp
            totals["rejected_log_probability"] += weight * rejected_logp
            totals["pair_margin"] += weight * margin
            totals["pair_accuracy"] += weight * float(margin > 0.0)
            totals["chosen_negative_log_probability"] += weight * -chosen_full_logp
            cases.append({
                "pair_id": row.get("pair_id"),
                "pair_digest": row.get("pair_digest"),
                "evidence_weight": weight,
                "chosen_log_probability": chosen_logp,
                "rejected_log_probability": rejected_logp,
                "pair_margin": margin,
                "pair_preferred": margin > 0.0,
                "chosen_negative_log_probability": -chosen_full_logp,
            })
    if totals["weight"] <= 0:
        raise SystemExit("Held-out evaluation has no positive evidence weight.")
    weight = totals.pop("weight")
    return {
        "rows": len(rows),
        "evidence_weight": weight,
        "mean_chosen_log_probability": totals["chosen_log_probability"] / weight,
        "mean_rejected_log_probability": totals["rejected_log_probability"] / weight,
        "mean_pair_margin": totals["pair_margin"] / weight,
        "pair_accuracy": totals["pair_accuracy"] / weight,
        "mean_chosen_negative_log_probability": totals["chosen_negative_log_probability"] / weight,
        "cases": cases,
    }


def compare_metrics(base: dict[str, Any], adapter: dict[str, Any]) -> dict[str, Any]:
    base_cases = {item["pair_id"]: item for item in base["cases"]}
    regressions = []
    repairs = []
    for item in adapter["cases"]:
        before = base_cases[item["pair_id"]]
        if before["pair_preferred"] and not item["pair_preferred"]:
            regressions.append(item["pair_id"])
        if not before["pair_preferred"] and item["pair_preferred"]:
            repairs.append(item["pair_id"])
    return {
        "pair_accuracy_delta": adapter["pair_accuracy"] - base["pair_accuracy"],
        "mean_pair_margin_delta": adapter["mean_pair_margin"] - base["mean_pair_margin"],
        "chosen_negative_log_probability_delta": adapter["mean_chosen_negative_log_probability"] - base["mean_chosen_negative_log_probability"],
        "repaired_pair_ids": sorted(repairs),
        "regressed_pair_ids": sorted(regressions),
        "non_regression": len(regressions) == 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter-dir", required=True)
    parser.add_argument("--evaluation-data", required=True)
    parser.add_argument("--training-receipt", required=True)
    parser.add_argument("--shard-receipt", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-seq-length", type=int, default=1536)
    args = parser.parse_args()

    profile_path = pathlib.Path(args.profile).resolve()
    model_dir = pathlib.Path(args.model_dir).resolve()
    adapter_dir = pathlib.Path(args.adapter_dir).resolve()
    evaluation_path = pathlib.Path(args.evaluation_data).resolve()
    training_receipt_path = pathlib.Path(args.training_receipt).resolve()
    shard_receipt_path = pathlib.Path(args.shard_receipt).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    profile = read_json(profile_path)
    cfg = require_profile(profile)
    seed = int(cfg["seed"])
    training_receipt = verify_receipt(training_receipt_path, "archie-neural-causal-divergence-training-receipt/v1")
    shard_receipt = verify_receipt(shard_receipt_path, "archie-segmented-tokenized-shard-receipt/v1")
    if training_receipt.get("method") != TRAINING_METHOD:
        raise SystemExit("Training receipt method mismatch.")
    if training_receipt.get("promotion") != "not-admitted":
        raise SystemExit("Training receipt attempted to bypass admission.")
    evaluation_rows = read_jsonl(evaluation_path, required=True)
    if not evaluation_rows:
        raise SystemExit("A nonempty global held-out split is required.")
    expected_eval_sha = shard_receipt.get("development", {}).get("sha256")
    if expected_eval_sha != sha256(evaluation_path):
        raise SystemExit("Held-out bytes do not match the segmented shard receipt.")

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    random.seed(seed)

    try:
        import torch
        from peft import LoraConfig, get_peft_model, get_peft_model_state_dict, prepare_model_for_kbit_training, set_peft_model_state_dict
        from peft.utils.save_and_load import load_peft_weights
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except Exception as exc:
        raise SystemExit("Pinned CUDA QLoRA dependencies are not installed in this environment.") from exc
    if not torch.cuda.is_available():
        raise SystemExit("Segment adapter verification requires real CUDA. Refusing CPU fallback.")

    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True

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
        raise SystemExit("Student checkpoint did not load in NF4 4-bit mode.")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=False)
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
    initial_state = {name: tensor.detach().cpu().clone() for name, tensor in get_peft_model_state_dict(model).items()}
    final_state = load_peft_weights(str(adapter_dir), device="cpu")
    proof = adapter_change_proof(initial_state, final_state)
    load_result = set_peft_model_state_dict(model, final_state)
    unexpected = sorted(getattr(load_result, "unexpected_keys", []) or [])
    mismatched = sorted(getattr(load_result, "mismatched_keys", []) or [])
    if unexpected or mismatched:
        raise SystemExit(f"Adapter state failed exact load; unexpected={unexpected[:4]}, mismatched={mismatched[:4]}.")

    base_metrics = evaluate_policy(model, evaluation_rows, tokenizer, args.max_seq_length, adapter_enabled=False)
    adapter_metrics = evaluate_policy(model, evaluation_rows, tokenizer, args.max_seq_length, adapter_enabled=True)
    comparison = compare_metrics(base_metrics, adapter_metrics)

    gpu_index = torch.cuda.current_device()
    gpu_properties = torch.cuda.get_device_properties(gpu_index)
    adapter_config_path = adapter_dir / "adapter_config.json"
    receipt_body = {
        "schema": SCHEMA,
        "method": METHOD,
        "training_method": TRAINING_METHOD,
        "request_id": shard_receipt.get("request_id"),
        "code_revision": shard_receipt.get("code_revision"),
        "round": int(shard_receipt.get("round", 0)),
        "shard_index": int(shard_receipt.get("shard_index", -1)),
        "profile": {"path": str(profile_path), "sha256": sha256(profile_path), "id": profile.get("id")},
        "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir), "tokenizer": tokenizer_identity(model_dir)},
        "adapter": {
            "path": str(adapter_dir),
            "directory": directory_identity(adapter_dir),
            "config_sha256": sha256(adapter_config_path),
            "training_receipt_sha256": sha256(training_receipt_path),
            "training_receipt_digest": training_receipt.get("receipt_digest"),
            "change_proof": proof,
        },
        "segmentation": {
            "shard_receipt_sha256": sha256(shard_receipt_path),
            "shard_receipt_digest": shard_receipt.get("receipt_digest"),
            "pair_receipt_digest": shard_receipt.get("pair_receipt_digest"),
            "tokenizer_identity_digest": shard_receipt.get("tokenizer_identity_digest"),
        },
        "held_out": {
            "path": str(evaluation_path),
            "sha256": sha256(evaluation_path),
            "base": base_metrics,
            "adapter": adapter_metrics,
            "comparison": comparison,
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packages": package_versions(["torch", "transformers", "peft", "bitsandbytes", "accelerate"]),
            "cuda": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "gpu": {
                "index": gpu_index,
                "name": torch.cuda.get_device_name(gpu_index),
                "capability": list(torch.cuda.get_device_capability(gpu_index)),
                "total_memory_bytes": gpu_properties.total_memory,
            },
        },
        "fusion_eligible": proof["changed_tensor_count"] > 0 and comparison["pair_accuracy_delta"] >= 0 and comparison["non_regression"],
        "promotion": "not-admitted",
        "claim_boundary": "This receipt proves changed LoRA tensors and a frozen-base versus adapter comparison on the bound global held-out split. It does not prove broad capability gain, GGUF retention, independent reproduction, or admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**receipt_body, "receipt_digest": hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest()}
    receipt_path = output / "segment-verification-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
