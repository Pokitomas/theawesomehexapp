#!/usr/bin/env python3
"""Fuse verified segmented LoRA adapters in exact delta space.

Independent LoRA factors cannot be averaged directly because average(B) @
average(A) is not the weighted average of B @ A. Archie therefore concatenates
rank blocks so the fused adapter exactly represents the weighted sum of source
LoRA deltas. Optional deterministic truncated SVD may compress the combined rank
when an explicit maximum is requested.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import shutil
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import artifact_manifest, read_json, sha256, stable  # type: ignore

REQUEST_SCHEMA = "archie-segment-adapter-fusion-request/v1"
VERIFICATION_SCHEMA = "archie-segment-adapter-verification-receipt/v1"
RECEIPT_SCHEMA = "archie-segment-adapter-fusion-receipt/v1"
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


def load_request(path: pathlib.Path) -> dict[str, Any]:
    value = read_json(path)
    if value.get("schema") != REQUEST_SCHEMA:
        raise SystemExit(f"{path} is not an Archie segment adapter fusion request v1.")
    if not isinstance(value.get("adapters"), list) or len(value["adapters"]) < 1:
        raise SystemExit("Fusion request requires at least one adapter.")
    return value


def score_receipt(receipt: dict[str, Any]) -> float:
    comparison = receipt.get("held_out", {}).get("comparison", {})
    accuracy_gain = float(comparison.get("pair_accuracy_delta", 0.0))
    margin_gain = float(comparison.get("mean_pair_margin_delta", 0.0))
    nll_delta = float(comparison.get("chosen_negative_log_probability_delta", 0.0))
    changed_fraction = float(receipt.get("adapter", {}).get("change_proof", {}).get("changed_fraction", 0.0))
    if receipt.get("fusion_eligible") is not True:
        return 0.0
    # Keep a small floor for verified non-regressive specialists so a narrow
    # shard is not discarded solely because the global split is coarse.
    return max(1e-6, accuracy_gain + 0.25 * max(0.0, margin_gain) + 0.1 * max(0.0, -nll_delta)) * max(0.25, changed_fraction)


def pair_key(key: str) -> tuple[str, str] | None:
    for side in ("A", "B"):
        marker = f".lora_{side}."
        if marker in key and key.endswith(".weight"):
            prefix, suffix = key.split(marker, 1)
            if suffix not in {"weight", "default.weight"}:
                raise SystemExit(f"Unsupported LoRA tensor key suffix: {key}")
            return prefix, side
    return None


def lora_scale(config: dict[str, Any]) -> float:
    rank = int(config.get("r", 0))
    alpha = float(config.get("lora_alpha", 0))
    if rank <= 0 or alpha <= 0:
        raise SystemExit("Adapter config requires positive r and lora_alpha.")
    if config.get("use_rslora"):
        return alpha / math.sqrt(rank)
    return alpha / rank


def validate_config(config: dict[str, Any]) -> None:
    if config.get("peft_type") not in {None, "LORA"}:
        raise SystemExit("Only LoRA adapters may be fused.")
    if config.get("fan_in_fan_out"):
        raise SystemExit("fan_in_fan_out LoRA is not supported by the current delta fuser.")
    if config.get("use_dora"):
        raise SystemExit("DoRA magnitude tensors are not supported by the current exact LoRA delta fuser.")
    if config.get("rank_pattern"):
        raise SystemExit("rank_pattern adapters require a future module-specific fusion schema.")
    if config.get("alpha_pattern"):
        raise SystemExit("alpha_pattern adapters require a future module-specific fusion schema.")
    if config.get("modules_to_save"):
        raise SystemExit("modules_to_save tensors are not LoRA deltas and cannot enter segmented fusion.")


def config_compatibility(config: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "base_model_name_or_path",
        "bias",
        "fan_in_fan_out",
        "inference_mode",
        "layers_pattern",
        "layers_to_transform",
        "megatron_config",
        "megatron_core",
        "peft_type",
        "revision",
        "target_modules",
        "task_type",
        "use_dora",
        "use_rslora",
    )
    return {key: config.get(key) for key in keys}


def compress_delta(delta: Any, rank: int) -> tuple[Any, Any, float]:
    import torch

    if rank <= 0:
        raise SystemExit("Compressed rank must be positive.")
    u, singular, vh = torch.linalg.svd(delta.float(), full_matrices=False)
    keep = min(rank, singular.numel())
    root = torch.sqrt(singular[:keep].clamp_min(0))
    b = u[:, :keep] * root.unsqueeze(0)
    a = root.unsqueeze(1) * vh[:keep, :]
    reconstructed = b @ a
    denominator = float(torch.linalg.vector_norm(delta.float()).item())
    error = float(torch.linalg.vector_norm(delta.float() - reconstructed).item()) / max(denominator, 1e-12)
    return a.to(delta.dtype), b.to(delta.dtype), error


def fuse_states(
    states: list[dict[str, Any]],
    configs: list[dict[str, Any]],
    weights: list[float],
    *,
    max_rank: int | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    import torch

    key_set = set(states[0])
    if not key_set:
        raise SystemExit("Adapter state is empty.")
    for index, state in enumerate(states[1:], start=1):
        if set(state) != key_set:
            raise SystemExit(f"Adapter {index} tensor keys do not match adapter 0.")
    parsed = {key: pair_key(key) for key in key_set}
    unsupported = sorted(key for key, value in parsed.items() if value is None)
    if unsupported:
        raise SystemExit(f"Fusion request contains non-LoRA tensors: {unsupported[:4]}")
    modules: dict[str, dict[str, str]] = {}
    for key, value in parsed.items():
        assert value is not None
        prefix, side = value
        modules.setdefault(prefix, {})[side] = key
    incomplete = sorted(prefix for prefix, sides in modules.items() if set(sides) != {"A", "B"})
    if incomplete:
        raise SystemExit(f"Incomplete LoRA A/B tensor pairs: {incomplete[:4]}")

    source_ranks = [int(config["r"]) for config in configs]
    combined_rank = sum(source_ranks)
    target_rank = combined_rank if max_rank is None else min(combined_rank, max_rank)
    compressed = target_rank < combined_rank
    fused: dict[str, Any] = {}
    module_receipts = []
    for prefix in sorted(modules):
        a_key = modules[prefix]["A"]
        b_key = modules[prefix]["B"]
        a_parts = []
        b_parts = []
        out_features = None
        in_features = None
        for index, (state, config, weight) in enumerate(zip(states, configs, weights)):
            a = state[a_key].detach().cpu().contiguous()
            b = state[b_key].detach().cpu().contiguous()
            if a.ndim != 2 or b.ndim != 2 or b.shape[1] != a.shape[0]:
                raise SystemExit(f"Invalid LoRA shapes for {prefix} in adapter {index}: A={tuple(a.shape)} B={tuple(b.shape)}")
            if int(a.shape[0]) != int(config["r"]):
                raise SystemExit(f"LoRA rank mismatch for {prefix} in adapter {index}.")
            out_features = int(b.shape[0]) if out_features is None else out_features
            in_features = int(a.shape[1]) if in_features is None else in_features
            if int(b.shape[0]) != out_features or int(a.shape[1]) != in_features:
                raise SystemExit(f"LoRA module dimensions differ for {prefix}.")
            a_parts.append(a)
            b_parts.append(b * (weight * lora_scale(config)))
        exact_a = torch.cat(a_parts, dim=0)
        exact_b = torch.cat(b_parts, dim=1)
        relative_error = 0.0
        if compressed:
            target_delta = exact_b.float() @ exact_a.float()
            fused_a, fused_b, relative_error = compress_delta(target_delta, target_rank)
        else:
            fused_a, fused_b = exact_a, exact_b
        fused[a_key] = fused_a
        fused[b_key] = fused_b
        module_receipts.append({
            "module": prefix,
            "input_features": in_features,
            "output_features": out_features,
            "source_rank": combined_rank,
            "fused_rank": int(fused_a.shape[0]),
            "relative_frobenius_error": relative_error,
        })
    summary = {
        "mode": "truncated-svd" if compressed else "exact-rank-concatenation",
        "source_rank_sum": combined_rank,
        "fused_rank": target_rank,
        "module_count": len(module_receipts),
        "maximum_relative_frobenius_error": max((item["relative_frobenius_error"] for item in module_receipts), default=0.0),
        "modules": module_receipts,
    }
    return fused, summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-rank", type=int)
    args = parser.parse_args()

    request_path = pathlib.Path(args.request).resolve()
    request = load_request(request_path)
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if args.max_rank is not None and args.max_rank < 1:
        raise SystemExit("max-rank must be positive.")
    output.mkdir(parents=True)
    adapter_output = output / "adapter"
    adapter_output.mkdir()

    try:
        import torch
        from safetensors.torch import load_file, save_file
    except Exception as exc:
        raise SystemExit("Pinned torch and safetensors are required for LoRA delta fusion.") from exc
    torch.manual_seed(int(request.get("seed", 3407)))
    torch.use_deterministic_algorithms(True)

    base = request_path.parent
    sources = []
    states = []
    configs = []
    raw_scores = []
    checkpoint_digests = set()
    federation_identities = set()
    compatibility = None
    for index, item in enumerate(request["adapters"]):
        if not isinstance(item, dict):
            raise SystemExit(f"adapters[{index}] must be an object.")
        adapter_dir = (base / str(item.get("adapter_dir") or "")).resolve()
        verification_path = (base / str(item.get("verification_receipt") or "")).resolve()
        receipt = verify_receipt(verification_path, VERIFICATION_SCHEMA)
        if receipt.get("method") != METHOD:
            raise SystemExit(f"Adapter {index} verification method mismatch.")
        if receipt.get("promotion") != "not-admitted":
            raise SystemExit(f"Adapter {index} attempted to bypass admission.")
        if int(receipt.get("adapter", {}).get("change_proof", {}).get("changed_tensor_count", 0)) < 1:
            raise SystemExit(f"Adapter {index} has no changed-tensor proof.")
        if receipt.get("fusion_eligible") is not True:
            raise SystemExit(f"Adapter {index} failed its held-out non-regression gate.")
        model_path = adapter_dir / "adapter_model.safetensors"
        config_path = adapter_dir / "adapter_config.json"
        if not model_path.is_file() or not config_path.is_file():
            raise SystemExit(f"Adapter {index} is missing adapter_model.safetensors or adapter_config.json.")
        config = read_json(config_path)
        validate_config(config)
        current_compatibility = config_compatibility(config)
        if compatibility is None:
            compatibility = current_compatibility
        elif stable(current_compatibility) != stable(compatibility):
            raise SystemExit(f"Adapter {index} configuration is incompatible with adapter 0.")
        checkpoint_digest = str(receipt.get("student_checkpoint", {}).get("directory_digest") or "")
        if not checkpoint_digest:
            raise SystemExit(f"Adapter {index} verification does not bind a base checkpoint digest.")
        checkpoint_digests.add(checkpoint_digest)
        request_id = str(receipt.get("request_id") or "")
        code_revision = str(receipt.get("code_revision") or "")
        if not request_id or len(code_revision) != 40:
            raise SystemExit(f"Adapter {index} does not bind a request and code revision.")
        federation_identities.add((request_id, code_revision, int(receipt.get("round", -1))))
        state = load_file(str(model_path), device="cpu")
        score = float(item.get("weight")) if item.get("weight") is not None else score_receipt(receipt)
        if not math.isfinite(score) or score <= 0:
            raise SystemExit(f"Adapter {index} is not fusion eligible or has a nonpositive weight.")
        states.append(state)
        configs.append(config)
        raw_scores.append(score)
        sources.append({
            "index": index,
            "round": receipt.get("round"),
            "shard_index": receipt.get("shard_index"),
            "adapter_dir": str(adapter_dir),
            "adapter_model_sha256": sha256(model_path),
            "adapter_config_sha256": sha256(config_path),
            "verification_receipt": str(verification_path),
            "verification_receipt_sha256": sha256(verification_path),
            "verification_receipt_digest": receipt.get("receipt_digest"),
            "raw_weight": score,
            "held_out_comparison": receipt.get("held_out", {}).get("comparison"),
        })
    if len(checkpoint_digests) != 1:
        raise SystemExit("Segment adapters do not share one exact base checkpoint digest.")
    if len(federation_identities) != 1:
        raise SystemExit("Segment adapters do not share one request, code revision, and recursive round.")
    request_id, code_revision, round_number = next(iter(federation_identities))
    total_score = sum(raw_scores)
    weights = [score / total_score for score in raw_scores]
    for source, weight in zip(sources, weights):
        source["normalized_weight"] = weight

    fused_state, fusion = fuse_states(states, configs, weights, max_rank=args.max_rank)
    fused_config = dict(configs[0])
    fused_config["r"] = int(fusion["fused_rank"])
    fused_config["lora_alpha"] = int(fusion["fused_rank"])
    fused_config["inference_mode"] = True
    fused_config["rank_pattern"] = {}
    fused_config["alpha_pattern"] = {}
    model_path = adapter_output / "adapter_model.safetensors"
    config_path = adapter_output / "adapter_config.json"
    save_file({key: tensor.contiguous() for key, tensor in sorted(fused_state.items())}, str(model_path), metadata={"format": "pt"})
    config_path.write_text(json.dumps(fused_config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    readme = adapter_output / "README.md"
    readme.write_text(
        "# Archie segmented fused adapter\n\n"
        "This candidate is a receipt-bound fusion artifact and remains `promotion: not-admitted`.\n",
        encoding="utf-8",
    )

    receipt_body = {
        "schema": RECEIPT_SCHEMA,
        "method": METHOD,
        "request_id": request_id,
        "code_revision": code_revision,
        "round": round_number,
        "request": {"path": str(request_path), "sha256": sha256(request_path)},
        "base_checkpoint_directory_digest": next(iter(checkpoint_digests)),
        "sources": sources,
        "fusion": fusion,
        "fused_adapter": {
            "path": str(adapter_output),
            "config_sha256": sha256(config_path),
            "model_sha256": sha256(model_path),
            "artifacts": artifact_manifest(adapter_output),
        },
        "promotion": "not-admitted",
        "novelty_boundary": "This repository method fuses independently trained LoRA specialists by exact rank concatenation of weighted delta factors, with optional bounded SVD compression. It is not a claim of globally unique prior art or improved capability without downstream evaluation.",
        "claim_boundary": "Fusion proves a deterministic adapter construction from verified changed tensors sharing one base checkpoint. It does not prove the fused adapter improves held-out quality or survives GGUF quantization.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**receipt_body, "receipt_digest": hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest()}
    receipt_path = output / "fusion-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
