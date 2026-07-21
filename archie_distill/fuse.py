from __future__ import annotations

import os
import pathlib
from typing import Any

from .core import (
    SCHEMA_EVALUATION,
    SCHEMA_FUSION,
    directory_identity,
    read_json,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
)


def parse_named_path(value: str) -> tuple[str, pathlib.Path]:
    name, separator, path = value.partition("=")
    if not separator or not name.strip() or not path.strip():
        raise ValueError("Adapters must use NAME=/local/path")
    return name.strip(), pathlib.Path(path).resolve()


def validated_non_regression_receipts(receipts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not receipts:
        raise ValueError("At least one evaluation receipt is required")
    for receipt in receipts:
        if receipt.get("schema") != SCHEMA_EVALUATION:
            raise ValueError("Fusion requires Archie evaluation v2 receipts")
        comparison = receipt.get("comparison") or {}
        if comparison.get("non_regression_passed") is not True:
            raise ValueError("Every fused adapter must pass base non-regression")
    return receipts


def configure_parser(parser: Any) -> None:
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter", action="append", required=True, help="NAME=/local/adapter/path")
    parser.add_argument("--receipt", action="append", required=True)
    parser.add_argument("--weight", action="append", type=float, default=[])
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    model_dir = pathlib.Path(args.model).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if not model_dir.is_dir():
        raise SystemExit(f"Local student checkpoint is missing: {model_dir}")
    adapters = [parse_named_path(item) for item in args.adapter]
    if len(adapters) < 2:
        raise SystemExit("Fusion requires at least two adapters")
    if len({name for name, _ in adapters}) != len(adapters):
        raise SystemExit("Adapter names must be unique")
    for _, path in adapters:
        if not path.is_dir():
            raise SystemExit(f"Adapter path is missing: {path}")
    receipt_paths = [pathlib.Path(item).resolve() for item in args.receipt]
    receipts = validated_non_regression_receipts([read_json(path) for path in receipt_paths])
    receipt_digests = {str(item.get("adapter", {}).get("digest")) for item in receipts}
    adapter_digests = {directory_identity(path)["digest"] for _, path in adapters}
    if receipt_digests != adapter_digests:
        raise SystemExit("Evaluation receipt adapter digests do not exactly match fusion inputs")
    weights = list(args.weight) if args.weight else [1.0 / len(adapters)] * len(adapters)
    if len(weights) != len(adapters):
        raise SystemExit("Provide one --weight per adapter, or omit all weights")
    if sum(abs(item) for item in weights) == 0:
        raise SystemExit("Fusion weights cannot all be zero")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, BitsAndBytesConfig
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before adapter fusion") from exc
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; CPU fallback is intentionally disabled")
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )
    base = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    first_name, first_path = adapters[0]
    model = PeftModel.from_pretrained(base, first_path, adapter_name=first_name, is_trainable=False)
    for name, path in adapters[1:]:
        model.load_adapter(path, adapter_name=name, is_trainable=False)
    fusion_name = "archie_fused"
    model.add_weighted_adapter(
        adapters=[name for name, _ in adapters],
        weights=weights,
        adapter_name=fusion_name,
        combination_type="linear",
    )
    model.set_adapter(fusion_name)
    adapter_dir = output / "adapter"
    output.mkdir(parents=True)
    model.save_pretrained(adapter_dir, selected_adapters=[fusion_name])
    receipt: dict[str, Any] = {
        "schema": SCHEMA_FUSION,
        "method": "peft-linear-weighted-adapter-fusion-after-non-regression/v1",
        "student_checkpoint": {"path": str(model_dir), **directory_identity(model_dir)},
        "inputs": [
            {
                "name": name,
                "path": str(path),
                **directory_identity(path),
                "weight": weights[index],
                "evaluation_receipt": {
                    "path": str(receipt_paths[index]),
                    "sha256": sha256_file(receipt_paths[index]),
                    "receipt_digest": receipts[index].get("receipt_digest"),
                },
            }
            for index, (name, path) in enumerate(adapters)
        ],
        "adapter": {"path": str(adapter_dir), **directory_identity(adapter_dir, include_files=True)},
        "promotion": "not-admitted",
        "claim_boundary": "Fusion completed only from non-regressing adapters. The fused adapter must still pass its own evaluation and quantization/reproduction gates.",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "fusion-receipt.json", receipt)
    return receipt
