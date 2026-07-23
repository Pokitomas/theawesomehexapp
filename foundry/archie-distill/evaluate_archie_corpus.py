#!/usr/bin/env python3
"""Compare Archie models on identical deterministic windows from one frozen corpus."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
from dataclasses import asdict
from typing import Any

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig
from archie_hybrid_corpus import atomic_json, stable_json, verify_u16_corpus
from archie_tokenizers import token_byte_lengths
from train_archie_hybrid import TokenSampler, evaluate


SCHEMA = "archie-corpus-comparison/v1"


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def amp_type(device: torch.device, value: str) -> torch.dtype | None:
    if device.type != "cuda" or value == "none":
        return None
    return torch.float16 if value == "float16" else torch.bfloat16


@torch.inference_mode()
def compare(args: argparse.Namespace) -> dict[str, Any]:
    corpus = pathlib.Path(args.corpus).resolve()
    corpus_metadata = verify_u16_corpus(corpus)
    device = torch.device(
        args.device if args.device != "auto" else (
            "cuda" if torch.cuda.is_available() else "cpu"
        )
    )
    precision = amp_type(device, args.amp_dtype)
    results = []
    for model_name in args.model:
        model_path = pathlib.Path(model_name).resolve()
        payload = torch.load(model_path, map_location=device, weights_only=False)
        if payload.get("schema") != "archie-scratch-hybrid-model/v1":
            raise ValueError(f"unsupported Archie model: {model_path}")
        config = ModelConfig(**payload["config"])
        if payload.get("tokenizer") != corpus_metadata["tokenizer"]:
            raise ValueError(f"model tokenizer differs from corpus: {model_path}")
        if args.sequence_length > config.max_seq_len:
            raise ValueError(f"sequence length exceeds model context: {model_path}")
        model = ArchieHybridLM(config).to(device)
        model.load_state_dict(payload["model"])
        sampler = TokenSampler(
            corpus, args.sequence_length, args.batch_size, args.seed
        )
        lengths = torch.tensor(
            token_byte_lengths(payload["tokenizer"]), device=device
        )
        metrics = evaluate(
            model, sampler, device, args.batches, precision, lengths, "token"
        )
        results.append(
            {
                "path": str(model_path),
                "sha256": sha256_file(model_path),
                "parameters": sum(parameter.numel() for parameter in model.parameters()),
                "config": asdict(config),
                "metrics": metrics,
            }
        )
        del model
        if device.type == "cuda":
            torch.cuda.empty_cache()
    baseline = results[0]["metrics"]
    for result in results:
        metrics = result["metrics"]
        metrics["bits_per_byte_gain_vs_first"] = (
            baseline["bits_per_byte"] - metrics["bits_per_byte"]
        )
        metrics["relative_bits_per_byte_gain_vs_first"] = (
            metrics["bits_per_byte_gain_vs_first"]
            / max(baseline["bits_per_byte"], 1e-12)
        )
    receipt = {
        "schema": SCHEMA,
        "corpus": {
            "path": str(corpus),
            "sha256": corpus_metadata["sha256"],
            "token_count": corpus_metadata["token_count"],
        },
        "evaluation": {
            "seed": args.seed,
            "sequence_length": args.sequence_length,
            "batch_size": args.batch_size,
            "batches": args.batches,
            "device": str(device),
            "amp_dtype": str(precision),
        },
        "models": results,
        "claim_boundary": (
            "Models were compared on identical deterministic corpus windows. This is a "
            "same-distribution loss comparison, not an independent capability admission."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(
        stable_json(receipt).encode("utf-8")
    ).hexdigest()
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--amp-dtype", choices=["none", "float16", "bfloat16"], default="float16")
    parser.add_argument("--sequence-length", type=int, default=1024)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--batches", type=int, default=32)
    parser.add_argument("--seed", type=int, default=20260723)
    args = parser.parse_args()
    if args.batch_size < 1 or args.batches < 1 or args.sequence_length < 2:
        parser.error("batch size, batches, and sequence length must be positive")
    receipt = compare(args)
    atomic_json(pathlib.Path(args.output).resolve(), receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
