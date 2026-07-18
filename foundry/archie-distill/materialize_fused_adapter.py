#!/usr/bin/env python3
"""Merge a receipt-bound fused LoRA adapter into its exact local base model."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import artifact_manifest, directory_identity, package_versions, read_json, sha256, stable, tokenizer_identity  # type: ignore

FUSION_SCHEMA = "archie-segment-adapter-fusion-receipt/v1"
RECEIPT_SCHEMA = "archie-segmented-merged-checkpoint-receipt/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"


def verify_receipt(path: pathlib.Path, expected_schema: str) -> dict[str, Any]:
    value = read_json(path)
    if value.get("schema") != expected_schema:
        raise SystemExit(f"Unexpected receipt schema in {path}.")
    body = dict(value)
    claimed = body.pop("receipt_digest", None)
    if not claimed or hashlib.sha256(stable(body).encode("utf-8")).hexdigest() != claimed:
        raise SystemExit(f"Receipt integrity failed for {path}.")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter-dir", required=True)
    parser.add_argument("--fusion-receipt", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()

    model_dir = pathlib.Path(args.model_dir).resolve()
    adapter_dir = pathlib.Path(args.adapter_dir).resolve()
    fusion_receipt_path = pathlib.Path(args.fusion_receipt).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    fusion = verify_receipt(fusion_receipt_path, FUSION_SCHEMA)
    if fusion.get("method") != METHOD or fusion.get("promotion") != "not-admitted":
        raise SystemExit("Fusion receipt method or promotion boundary mismatch.")
    base_identity = directory_identity(model_dir)
    if base_identity.get("directory_digest") != fusion.get("base_checkpoint_directory_digest"):
        raise SystemExit("Local base checkpoint does not match the fused adapter receipt.")
    if sha256(adapter_dir / "adapter_model.safetensors") != fusion.get("fused_adapter", {}).get("model_sha256"):
        raise SystemExit("Fused adapter model bytes do not match the fusion receipt.")
    if sha256(adapter_dir / "adapter_config.json") != fusion.get("fused_adapter", {}).get("config_sha256"):
        raise SystemExit("Fused adapter config bytes do not match the fusion receipt.")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as exc:
        raise SystemExit("Pinned Transformers, PEFT, and torch are required to materialize a fused adapter.") from exc
    if args.device == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA materialization was requested but no CUDA device is available.")
    device_map: Any = {"": torch.cuda.current_device()} if args.device == "cuda" else {"": "cpu"}
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        torch_dtype=torch.float16,
        device_map=device_map,
        local_files_only=True,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(model, adapter_dir, is_trainable=False, local_files_only=True)
    merged = model.merge_and_unload(safe_merge=True)
    merged.save_pretrained(output, safe_serialization=True, max_shard_size="4GB")
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    tokenizer.save_pretrained(output)

    receipt_body = {
        "schema": RECEIPT_SCHEMA,
        "method": METHOD,
        "base_checkpoint": {"path": str(model_dir), **base_identity, "tokenizer": tokenizer_identity(model_dir)},
        "fused_adapter": {
            "path": str(adapter_dir),
            "model_sha256": sha256(adapter_dir / "adapter_model.safetensors"),
            "config_sha256": sha256(adapter_dir / "adapter_config.json"),
        },
        "fusion_receipt": {"path": str(fusion_receipt_path), "sha256": sha256(fusion_receipt_path), "receipt_digest": fusion.get("receipt_digest")},
        "materialization": {
            "device": args.device,
            "safe_merge": True,
            "torch_dtype": "float16",
            "output": str(output),
            "artifacts": artifact_manifest(output),
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packages": package_versions(["torch", "transformers", "peft", "accelerate", "safetensors"]),
            "cuda": torch.version.cuda if args.device == "cuda" else None,
        },
        "promotion": "not-admitted",
        "claim_boundary": "This receipt proves that the fused LoRA delta was safely merged into the exact bound base checkpoint. It does not prove capability gain, GGUF conversion quality, quantization retention, or admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**receipt_body, "receipt_digest": hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest()}
    receipt_path = output / "segmented-merge-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
