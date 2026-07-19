#!/usr/bin/env python3
"""Fuse verified Archie adapters while canonicalizing absorbed RSLoRA scales.

The existing delta fuser correctly multiplies every source B matrix by that
adapter's effective scale (alpha / sqrt(rank) for RSLoRA, alpha / rank for LoRA)
before concatenation. A fused adapter must therefore be emitted with unit scale.
Keeping `use_rslora=true` on the fused config would multiply the already-scaled
delta by sqrt(fused_rank) a second time. This wrapper preserves the existing exact
fusion math and emits a canonical ordinary-LoRA config with alpha == rank.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fuse_segment_adapters as base  # type: ignore
from train import artifact_manifest, read_json, sha256, stable  # type: ignore


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-rank", type=int)
    args = parser.parse_args()

    request_path = pathlib.Path(args.request).resolve()
    request = base.load_request(request_path)
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

    root = request_path.parent
    sources = []
    states = []
    configs = []
    raw_scores = []
    checkpoint_digests = set()
    federation_identities = set()
    compatibility = None
    source_scaling = []

    for index, item in enumerate(request["adapters"]):
        if not isinstance(item, dict):
            raise SystemExit(f"adapters[{index}] must be an object.")
        adapter_dir = (root / str(item.get("adapter_dir") or "")).resolve()
        verification_path = (root / str(item.get("verification_receipt") or "")).resolve()
        receipt = base.verify_receipt(verification_path, base.VERIFICATION_SCHEMA)
        if receipt.get("method") != base.METHOD:
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
        base.validate_config(config)
        current_compatibility = base.config_compatibility(config)
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
        score = float(item.get("weight")) if item.get("weight") is not None else base.score_receipt(receipt)
        if not math.isfinite(score) or score <= 0:
            raise SystemExit(f"Adapter {index} is not fusion eligible or has a nonpositive weight.")
        effective_scale = base.lora_scale(config)
        source_scaling.append({
            "index": index,
            "rank": int(config.get("r", 0)),
            "alpha": float(config.get("lora_alpha", 0)),
            "use_rslora": bool(config.get("use_rslora")),
            "effective_scale": effective_scale,
        })
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
            "effective_source_scale": effective_scale,
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

    fused_state, fusion = base.fuse_states(states, configs, weights, max_rank=args.max_rank)
    fused_config = dict(configs[0])
    fused_rank = int(fusion["fused_rank"])
    fused_config["r"] = fused_rank
    fused_config["lora_alpha"] = fused_rank
    fused_config["use_rslora"] = False
    fused_config["inference_mode"] = True
    fused_config["rank_pattern"] = {}
    fused_config["alpha_pattern"] = {}
    fusion = {
        **fusion,
        "source_scaling": source_scaling,
        "source_scaling_absorbed_into_delta_factors": True,
        "output_adapter_scaling": "unit alpha/rank",
        "output_use_rslora": False,
    }

    model_path = adapter_output / "adapter_model.safetensors"
    config_path = adapter_output / "adapter_config.json"
    save_file({key: tensor.contiguous() for key, tensor in sorted(fused_state.items())}, str(model_path), metadata={"format": "pt"})
    config_path.write_text(json.dumps(fused_config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (adapter_output / "README.md").write_text(
        "# Archie information-budgeted fused adapter\n\n"
        "Source LoRA/RSLoRA scales are absorbed into the exact delta factors. The output uses unit ordinary-LoRA scaling and remains `promotion: not-admitted`.\n",
        encoding="utf-8",
    )

    receipt_body = {
        "schema": base.RECEIPT_SCHEMA,
        "method": base.METHOD,
        "training_method": "information-budgeted-causal-fork-rslora/v1",
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
        "novelty_boundary": "The repository experiment combines verified information-budgeted specialists with exact scale-aware delta fusion. RSLoRA and LoRA fusion have prior art; downstream gain remains empirical.",
        "claim_boundary": "Fusion proves a deterministic unit-scaled adapter construction from verified changed tensors. It does not prove held-out gain, quantization retention, reproduction, or admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**receipt_body, "receipt_digest": hashlib.sha256(stable(receipt_body).encode("utf-8")).hexdigest()}
    (output / "fusion-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
