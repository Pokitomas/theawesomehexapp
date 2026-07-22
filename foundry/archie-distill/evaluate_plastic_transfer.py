#!/usr/bin/env python3
"""Measure whether Archie fast weights improve frozen support-to-query transfer."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import tempfile
from collections import defaultdict
from typing import Any

import torch
import torch.nn.functional as F

from archie_hybrid_core import PAD_ID, ArchieHybridLM, ModelConfig, PRESETS
from archie_hybrid_corpus import atomic_json, stable_json
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata

SCHEMA = "archie-plastic-transfer-suite/v1"
RECEIPT_SCHEMA = "archie-plastic-transfer-receipt/v1"


def score_query(
    model: ArchieHybridLM, tokens: torch.Tensor, byte_lengths: torch.Tensor,
    plastic_state: torch.Tensor | None,
) -> tuple[float, int, int]:
    output = model(tokens, plastic_state=plastic_state)
    targets = tokens[:, 1:]
    losses = F.cross_entropy(
        output["logits"][:, :-1].float().reshape(-1, output["logits"].size(-1)),
        targets.reshape(-1), ignore_index=PAD_ID, reduction="none",
    ).reshape_as(targets)
    valid = targets.ne(PAD_ID)
    nats = float(losses[valid].sum().cpu())
    count = int(valid.sum().cpu())
    bytes_ = int(byte_lengths[targets][valid].sum().cpu())
    return nats, count, bytes_


@torch.no_grad()
def evaluate(
    model_path: pathlib.Path, suite_path: pathlib.Path, device: torch.device,
    minimum_effect: float,
) -> dict[str, Any]:
    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    if suite.get("schema") != SCHEMA:
        raise ValueError("unsupported plastic transfer suite")
    if suite.get("frozen") is not True or suite.get("training_excluded") is not True:
        raise ValueError("plastic transfer suite must declare frozen and training_excluded")
    cases = suite.get("cases")
    if not isinstance(cases, list) or len(cases) < 3:
        raise ValueError("plastic transfer suite requires at least three cases")
    payload = torch.load(model_path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise ValueError("unsupported Archie model")
    config = ModelConfig(**payload["config"])
    if config.plastic_mode != "delta":
        raise ValueError("plastic transfer evaluation requires plastic_mode=delta")
    tokenizer_metadata = payload["tokenizer"]
    tokenizer = tokenizer_from_metadata(tokenizer_metadata)
    model = ArchieHybridLM(config).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    lengths = torch.tensor(token_byte_lengths(tokenizer_metadata), device=device)
    results = []
    groups: dict[str, list[float]] = defaultdict(list)
    case_ids: set[str] = set()
    for case in cases:
        for field in ("id", "repository_id", "mechanism_id", "task_family", "support", "query"):
            if not str(case.get(field, "")).strip():
                raise ValueError(f"plastic transfer case requires {field}")
        if str(case["id"]) in case_ids:
            raise ValueError(f"duplicate plastic transfer case id: {case['id']}")
        case_ids.add(str(case["id"]))
        support_ids = tokenizer.encode(str(case["support"]), bos=True, eos=True)
        query_ids = tokenizer.encode(str(case["query"]), bos=True, eos=True)
        if len(support_ids) > config.max_seq_len or len(query_ids) > config.max_seq_len:
            raise ValueError(f"case {case['id']} exceeds model context")
        support = torch.tensor([support_ids], dtype=torch.long, device=device)
        query = torch.tensor([query_ids], dtype=torch.long, device=device)
        support_output = model(support)
        plastic_state = support_output["plastic_state"]
        reset_nats, reset_tokens, reset_bytes = score_query(model, query, lengths, None)
        adapted_nats, adapted_tokens, adapted_bytes = score_query(
            model, query, lengths, plastic_state
        )
        if reset_bytes != adapted_bytes or reset_tokens != adapted_tokens:
            raise AssertionError("reset and adapted query accounting diverged")
        reset_bpb = reset_nats / max(reset_bytes, 1) / math.log(2.0)
        adapted_bpb = adapted_nats / max(adapted_bytes, 1) / math.log(2.0)
        relative_effect = (reset_bpb - adapted_bpb) / max(reset_bpb, 1e-12)
        results.append(
            {
                "id": case["id"], "repository_id": case["repository_id"],
                "mechanism_id": case["mechanism_id"], "task_family": case["task_family"],
                "reset_bits_per_byte": reset_bpb,
                "adapted_bits_per_byte": adapted_bpb,
                "relative_effect": relative_effect,
                "plastic_state_l2": float(plastic_state.float().norm().cpu()),
                "plastic_state_bytes": plastic_state.numel() * plastic_state.element_size(),
            }
        )
        groups[str(case["task_family"])].append(relative_effect)
    mean_reset = sum(item["reset_bits_per_byte"] for item in results) / len(results)
    mean_adapted = sum(item["adapted_bits_per_byte"] for item in results) / len(results)
    mean_effect = (mean_reset - mean_adapted) / max(mean_reset, 1e-12)
    improved_fraction = sum(item["relative_effect"] > 0 for item in results) / len(results)
    passed = mean_effect >= minimum_effect and improved_fraction >= 0.6
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "model_sha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "suite_sha256": hashlib.sha256(suite_path.read_bytes()).hexdigest(),
        "cases": results,
        "groups": {
            group: {"cases": len(values), "mean_relative_effect": sum(values) / len(values)}
            for group, values in sorted(groups.items())
        },
        "metrics": {
            "reset_bits_per_byte": mean_reset,
            "adapted_bits_per_byte": mean_adapted,
            "mean_relative_effect": mean_effect,
            "improved_fraction": improved_fraction,
            "minimum_effect": minimum_effect,
            "passed": passed,
        },
        "promotion": "plasticity-probe-only",
        "claim_boundary": (
            "Measures stateful support-to-query compression on a frozen excluded suite; "
            "it does not establish general continual learning or safe slow-weight consolidation."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    return receipt


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        config = ModelConfig(
            **{**PRESETS["micro"].__dict__, "plastic_mode": "delta", "plastic_rank": 4}
        )
        model = ArchieHybridLM(config)
        model_path = root / "model.pt"
        tokenizer = {
            "schema": "archie-byte-tokenizer/v1", "encoding": "utf-8-bytes",
            "vocab_size": 260,
            "special_tokens": {"pad": 256, "bos": 257, "eos": 258, "sep": 259},
        }
        torch.save(
            {
                "schema": "archie-scratch-hybrid-model/v1",
                "config": config.__dict__, "model": model.state_dict(), "tokenizer": tokenizer,
            },
            model_path,
        )
        suite = {
            "schema": SCHEMA, "frozen": True, "training_excluded": True,
            "cases": [
                {
                    "id": f"case-{index}", "repository_id": f"repo-{index}",
                    "mechanism_id": "mapping", "task_family": "recall",
                    "support": f"artifact {index} maps to action verify",
                    "query": f"artifact {index} maps to action",
                }
                for index in range(3)
            ],
        }
        suite_path = root / "suite.json"
        suite_path.write_text(json.dumps(suite), encoding="utf-8")
        receipt = evaluate(model_path, suite_path, torch.device("cpu"), 0.0)
        assert len(receipt["cases"]) == 3
        assert all(math.isfinite(item["relative_effect"]) for item in receipt["cases"])
        print(json.dumps({"selftest": "passed", "receipt_digest": receipt["receipt_digest"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model")
    parser.add_argument("--suite")
    parser.add_argument("--output")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--minimum-effect", type=float, default=0.03)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.model or not args.suite or not args.output:
        parser.error("--model, --suite, and --output are required")
    receipt = evaluate(
        pathlib.Path(args.model).resolve(), pathlib.Path(args.suite).resolve(),
        torch.device(args.device), args.minimum_effect,
    )
    atomic_json(pathlib.Path(args.output).resolve(), receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
