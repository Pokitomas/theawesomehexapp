#!/usr/bin/env python3
"""Evaluate one fused adapter against its exact frozen NF4 base on held-out pairs.

This is the final neural gate before GGUF materialization. It validates the
fusion receipt and adapter bytes, loads the exact local base checkpoint once,
evaluates the same held-out causal pairs with the adapter disabled and enabled,
and requires non-regression plus at least one strict measured improvement.
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
from verify_segment_adapter import compare_metrics, evaluate_policy, verify_receipt  # type: ignore

SCHEMA = "archie-fused-adapter-evaluation-receipt/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"
FUSION_SCHEMA = "archie-segment-adapter-fusion-receipt/v1"
SEGMENTATION_SCHEMA = "archie-segmented-tokenized-distillation-receipt/v1"


def strict_gain(comparison: dict[str, Any], *, epsilon: float = 1e-9) -> bool:
    return bool(
        float(comparison.get("pair_accuracy_delta", 0.0)) > epsilon
        or float(comparison.get("mean_pair_margin_delta", 0.0)) > epsilon
        or float(comparison.get("chosen_negative_log_probability_delta", 0.0)) < -epsilon
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter-dir", required=True)
    parser.add_argument("--fusion-receipt", required=True)
    parser.add_argument("--segmentation-receipt", required=True)
    parser.add_argument("--evaluation-data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-seq-length", type=int, default=1536)
    args = parser.parse_args()

    profile_path = pathlib.Path(args.profile).resolve()
    model_dir = pathlib.Path(args.model_dir).resolve()
    adapter_dir = pathlib.Path(args.adapter_dir).resolve()
    fusion_receipt_path = pathlib.Path(args.fusion_receipt).resolve()
    segmentation_receipt_path = pathlib.Path(args.segmentation_receipt).resolve()
    evaluation_path = pathlib.Path(args.evaluation_data).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    profile = read_json(profile_path)
    cfg = require_profile(profile)
    seed = int(cfg["seed"])
    fusion = verify_receipt(fusion_receipt_path, FUSION_SCHEMA)
    segmentation = verify_receipt(segmentation_receipt_path, SEGMENTATION_SCHEMA)
    if fusion.get("method") != METHOD or segmentation.get("method") != METHOD:
        raise SystemExit("Segmented distillation method mismatch.")
    if fusion.get("promotion") != "not-admitted" or segmentation.get("promotion") != "not-admitted":
        raise SystemExit("Input receipt attempted to bypass admission.")
    expected_base = str(fusion.get("base_checkpoint_directory_digest") or "")
    observed_base = str(directory_identity(model_dir).get("directory_digest") or "")
    if not expected_base or observed_base != expected_base:
        raise SystemExit("Fused adapter does not bind the supplied base checkpoint bytes.")
    expected_development = segmentation.get("source", {}).get("development", {})
    if expected_development.get("sha256") != sha256(evaluation_path):
        raise SystemExit("Held-out bytes do not match the segmentation receipt.")
    rows = read_jsonl(evaluation_path, required=True)
    if len(rows) != int(expected_development.get("rows", -1)) or not rows:
        raise SystemExit("Held-out row count does not match the segmentation receipt.")

    model_file = adapter_dir / "adapter_model.safetensors"
    config_file = adapter_dir / "adapter_config.json"
    expected_adapter = fusion.get("fused_adapter", {})
    if sha256(model_file) != expected_adapter.get("model_sha256"):
        raise SystemExit("Fused adapter tensor bytes do not match the fusion receipt.")
    if sha256(config_file) != expected_adapter.get("config_sha256"):
        raise SystemExit("Fused adapter config bytes do not match the fusion receipt.")

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    random.seed(seed)

    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except Exception as exc:
        raise SystemExit("Pinned CUDA QLoRA dependencies are not installed in this environment.") from exc
    if not torch.cuda.is_available():
        raise SystemExit("Fused adapter evaluation requires real CUDA. Refusing CPU fallback.")

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
    base_model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    if not getattr(base_model, "is_loaded_in_4bit", False):
        raise SystemExit("Student checkpoint did not load in NF4 4-bit mode.")
    base_model.config.use_cache = False
    model = PeftModel.from_pretrained(base_model, adapter_dir, is_trainable=False, local_files_only=True)

    base_metrics = evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=False)
    fused_metrics = evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=True)
    comparison = compare_metrics(base_metrics, fused_metrics)
    gain = strict_gain(comparison)
    evaluation_passed = bool(comparison["non_regression"] and comparison["pair_accuracy_delta"] >= 0 and gain)

    gpu_index = torch.cuda.current_device()
    gpu_properties = torch.cuda.get_device_properties(gpu_index)
    receipt_body = {
        "schema": SCHEMA,
        "method": METHOD,
        "profile": {"path": str(profile_path), "sha256": sha256(profile_path), "id": profile.get("id")},
        "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir), "tokenizer": tokenizer_identity(model_dir)},
        "fusion": {
            "receipt_path": str(fusion_receipt_path),
            "receipt_sha256": sha256(fusion_receipt_path),
            "receipt_digest": fusion.get("receipt_digest"),
            "adapter_path": str(adapter_dir),
            "adapter_model_sha256": sha256(model_file),
            "adapter_config_sha256": sha256(config_file),
        },
        "segmentation": {
            "receipt_path": str(segmentation_receipt_path),
            "receipt_sha256": sha256(segmentation_receipt_path),
            "receipt_digest": segmentation.get("receipt_digest"),
            "round": segmentation.get("round"),
        },
        "held_out": {
            "path": str(evaluation_path),
            "sha256": sha256(evaluation_path),
            "base": base_metrics,
            "fused_adapter": fused_metrics,
            "comparison": comparison,
        },
        "capability_gain_observed": gain,
        "evaluation_passed": evaluation_passed,
        "quantization_eligible": evaluation_passed,
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
        "promotion": "not-admitted",
        "claim_boundary": "This receipt proves a strict measured improvement without held-out pair regressions on the bound split before quantization. It does not prove broad capability, GGUF retention, independent reproduction, or admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**receipt_body, "receipt_digest": hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest()}
    receipt_path = output / "fused-adapter-evaluation-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if not evaluation_passed:
        raise SystemExit("Fused adapter did not produce a strict non-regressive held-out improvement; quantization refused.")


if __name__ == "__main__":
    main()
