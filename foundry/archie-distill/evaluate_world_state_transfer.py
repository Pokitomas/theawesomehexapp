#!/usr/bin/env python3
"""Falsify world-state usefulness with correct, reset, and wrong-support controls."""
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

from archie_world_state_core import MODEL_SCHEMA, PAD_ID, ArchieWorldStateLM, WorldStateConfig

SUITE_SCHEMA = "archie-world-state-transfer-suite/v1"
RECEIPT_SCHEMA = "archie-world-state-transfer-receipt/v1"


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(text: str, tokenizer: dict[str, Any]) -> list[int]:
    if tokenizer.get("schema") != "archie-byte-tokenizer/v1":
        raise ValueError("world-state transfer evaluator currently requires the byte tokenizer")
    special = tokenizer["special_tokens"]
    return [int(special["bos"]), *text.encode("utf-8", errors="replace"), int(special["eos"])]


def score(model: ArchieWorldStateLM, tokens: torch.Tensor, state: torch.Tensor | None) -> tuple[float, int]:
    output = model(tokens, world_state=state)
    targets = tokens[:, 1:]
    losses = F.cross_entropy(
        output["logits"][:, :-1].float().reshape(-1, output["logits"].size(-1)),
        targets.reshape(-1), ignore_index=PAD_ID, reduction="none",
    ).reshape_as(targets)
    valid = targets.ne(PAD_ID)
    return float(losses[valid].sum().cpu()), int(valid.sum().cpu())


@torch.no_grad()
def evaluate(
    model_path: pathlib.Path,
    suite_path: pathlib.Path,
    device: torch.device,
    minimum_reset_gain: float,
    minimum_wrong_gain: float,
) -> dict[str, Any]:
    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    if suite.get("schema") != SUITE_SCHEMA:
        raise ValueError("unsupported world-state transfer suite")
    if suite.get("frozen") is not True or suite.get("training_excluded") is not True:
        raise ValueError("suite must declare frozen and training_excluded")
    cases = suite.get("cases")
    if not isinstance(cases, list) or len(cases) < 3:
        raise ValueError("suite requires at least three cases")
    payload = torch.load(model_path, map_location=device, weights_only=False)
    if payload.get("schema") != MODEL_SCHEMA:
        raise ValueError("unsupported world-state model")
    model = ArchieWorldStateLM(WorldStateConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    tokenizer = payload["tokenizer"]
    results = []
    groups: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for case in cases:
        for field in ("id", "repository_id", "mechanism_id", "task_family", "support", "wrong_support", "query"):
            if not str(case.get(field, "")).strip():
                raise ValueError(f"case requires {field}")
        support = torch.tensor([encode(str(case["support"]), tokenizer)], dtype=torch.long, device=device)
        wrong_support = torch.tensor([encode(str(case["wrong_support"]), tokenizer)], dtype=torch.long, device=device)
        query = torch.tensor([encode(str(case["query"]), tokenizer)], dtype=torch.long, device=device)
        if max(support.size(1), wrong_support.size(1), query.size(1)) > model.cfg.max_seq_len:
            raise ValueError(f"case {case['id']} exceeds model context")
        correct_state = model(support)["world_state"]
        wrong_state = model(wrong_support)["world_state"]
        adapted_nats, count = score(model, query, correct_state)
        reset_nats, reset_count = score(model, query, None)
        wrong_nats, wrong_count = score(model, query, wrong_state)
        if count != reset_count or count != wrong_count:
            raise AssertionError("query accounting diverged")
        denominator = max(count * math.log(2.0), 1e-12)
        adapted_bpt = adapted_nats / denominator
        reset_bpt = reset_nats / denominator
        wrong_bpt = wrong_nats / denominator
        reset_gain = (reset_bpt - adapted_bpt) / max(reset_bpt, 1e-12)
        wrong_gain = (wrong_bpt - adapted_bpt) / max(wrong_bpt, 1e-12)
        results.append({
            "id": case["id"], "repository_id": case["repository_id"],
            "mechanism_id": case["mechanism_id"], "task_family": case["task_family"],
            "adapted_bits_per_token": adapted_bpt, "reset_bits_per_token": reset_bpt,
            "wrong_bits_per_token": wrong_bpt, "gain_vs_reset": reset_gain,
            "gain_vs_wrong": wrong_gain, "correct_state_l2": float(correct_state.norm().cpu()),
            "wrong_state_l2": float(wrong_state.norm().cpu()),
        })
        groups[str(case["task_family"])].append((reset_gain, wrong_gain))
    mean_reset = sum(item["gain_vs_reset"] for item in results) / len(results)
    mean_wrong = sum(item["gain_vs_wrong"] for item in results) / len(results)
    reset_fraction = sum(item["gain_vs_reset"] > 0 for item in results) / len(results)
    wrong_fraction = sum(item["gain_vs_wrong"] > 0 for item in results) / len(results)
    passed = (
        mean_reset >= minimum_reset_gain and mean_wrong >= minimum_wrong_gain
        and reset_fraction >= 0.6 and wrong_fraction >= 0.6
    )
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "model_sha256": sha256_file(model_path),
        "suite_sha256": sha256_file(suite_path),
        "cases": results,
        "groups": {
            name: {
                "cases": len(values),
                "mean_gain_vs_reset": sum(value[0] for value in values) / len(values),
                "mean_gain_vs_wrong": sum(value[1] for value in values) / len(values),
            }
            for name, values in sorted(groups.items())
        },
        "metrics": {
            "mean_gain_vs_reset": mean_reset,
            "mean_gain_vs_wrong": mean_wrong,
            "improved_vs_reset_fraction": reset_fraction,
            "improved_vs_wrong_fraction": wrong_fraction,
            "minimum_reset_gain": minimum_reset_gain,
            "minimum_wrong_gain": minimum_wrong_gain,
            "passed": passed,
        },
        "promotion": "world-state-probe-only",
        "claim_boundary": (
            "Correct support must beat both no state and semantically wrong support. A changing or large "
            "state alone is not evidence of useful memory."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(
        json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return receipt


def selftest() -> None:
    from dataclasses import asdict
    from archie_world_state_core import PRESETS
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        model = ArchieWorldStateLM(PRESETS["micro"])
        model_path = root / "model.pt"
        tokenizer = {
            "schema": "archie-byte-tokenizer/v1", "encoding": "utf-8-bytes", "vocab_size": 260,
            "special_tokens": {"pad": 256, "bos": 257, "eos": 258, "sep": 259},
        }
        torch.save({
            "schema": MODEL_SCHEMA, "config": asdict(PRESETS["micro"]),
            "model": model.state_dict(), "tokenizer": tokenizer,
        }, model_path)
        cases = [{
            "id": f"case-{index}", "repository_id": f"repo-{index}",
            "mechanism_id": "mapping", "task_family": "recall",
            "support": f"key {index} means verify", "wrong_support": f"key {index} means delete",
            "query": f"key {index} means",
        } for index in range(3)]
        suite_path = root / "suite.json"
        suite_path.write_text(json.dumps({
            "schema": SUITE_SCHEMA, "frozen": True, "training_excluded": True, "cases": cases,
        }), encoding="utf-8")
        receipt = evaluate(model_path, suite_path, torch.device("cpu"), -1.0, -1.0)
        assert len(receipt["cases"]) == 3
        assert all(math.isfinite(item["gain_vs_wrong"]) for item in receipt["cases"])
        print(json.dumps({"selftest": "passed", "receipt_digest": receipt["receipt_digest"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model")
    parser.add_argument("--suite")
    parser.add_argument("--output")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--minimum-reset-gain", type=float, default=0.03)
    parser.add_argument("--minimum-wrong-gain", type=float, default=0.03)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.model or not args.suite or not args.output:
        parser.error("--model, --suite, and --output are required")
    receipt = evaluate(
        pathlib.Path(args.model).resolve(), pathlib.Path(args.suite).resolve(),
        torch.device(args.device), args.minimum_reset_gain, args.minimum_wrong_gain,
    )
    pathlib.Path(args.output).resolve().write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
