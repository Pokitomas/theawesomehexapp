#!/usr/bin/env python3
"""Search a causal task-vector merge without consuming the final temporal holdout."""
from __future__ import annotations

import argparse
import json
import pathlib
from dataclasses import asdict
from typing import Any

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig, parameter_count
from archie_tokenizers import tokenizer_from_metadata
from train_archie_git_experience import (
    atomic_json, digest, evaluate, load_receipt, load_rows, sha256_file, tokenize_rows,
)

SCHEMA = "archie-causal-task-vector-merge-receipt/v1"


def load_model(path: pathlib.Path) -> dict[str, Any]:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise SystemExit(f"unsupported Archie model: {path}")
    return payload


def merged_state(
    base: dict[str, torch.Tensor], specialist: dict[str, torch.Tensor], alpha: float,
) -> dict[str, torch.Tensor]:
    if set(base) != set(specialist):
        raise SystemExit("task-vector models have different state keys")
    merged: dict[str, torch.Tensor] = {}
    for name in sorted(base):
        left = base[name]
        right = specialist[name]
        if left.shape != right.shape or left.dtype != right.dtype:
            raise SystemExit(f"task-vector tensor mismatch: {name}")
        merged[name] = left + (right - left) * alpha if left.is_floating_point() else left.clone()
    return merged


def temporal_partition(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    groups = sorted({(int(row["order"]), str(row["commit"])) for row in rows})
    if len(groups) < 4:
        raise SystemExit("development history needs at least four temporal commit groups")
    boundary = len(groups) // 2
    selection_commits = {commit for _, commit in groups[:boundary]}
    final_commits = {commit for _, commit in groups[boundary:]}
    selection = [row for row in rows if row["commit"] in selection_commits]
    final = [row for row in rows if row["commit"] in final_commits]
    if not selection or not final:
        raise SystemExit("temporal merge partition is empty")
    return selection, final


def evaluate_state(
    state: dict[str, torch.Tensor], cfg: ModelConfig, items: list[dict[str, Any]],
    device: torch.device, amp_dtype: torch.dtype | None, preference_weight: float,
    causal_margin: float,
) -> dict[str, Any]:
    model = ArchieHybridLM(cfg).to(device)
    model.load_state_dict(state)
    metrics = evaluate(
        model, items, device, amp_dtype, 0, preference_weight, causal_margin,
    )
    del model
    if device.type == "cuda":
        torch.cuda.empty_cache()
    return metrics


def search(args: argparse.Namespace) -> dict[str, Any]:
    base_path = pathlib.Path(args.base_model).resolve()
    specialist_path = pathlib.Path(args.specialist_model).resolve()
    data_path = pathlib.Path(args.development_data).resolve()
    data_receipt_path = pathlib.Path(args.data_receipt).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"refusing non-empty output directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    data_receipt = load_receipt(data_receipt_path)
    rows = load_rows(data_path, data_receipt, "development")
    selection_rows, final_rows = temporal_partition(rows)
    base = load_model(base_path)
    specialist = load_model(specialist_path)
    if base["config"] != specialist["config"] or base["tokenizer"] != specialist["tokenizer"]:
        raise SystemExit("task-vector models have different architecture or tokenizer")
    cfg = ModelConfig(**base["config"])
    if args.max_seq_length > cfg.max_seq_len:
        raise SystemExit("merge evaluation sequence exceeds model maximum")
    tokenizer = tokenizer_from_metadata(base["tokenizer"])
    selection_items = tokenize_rows(
        tokenizer, selection_rows, args.max_seq_length, args.max_target_tokens,
    )
    final_items = tokenize_rows(
        tokenizer, final_rows, args.max_seq_length, args.max_target_tokens,
    )
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    amp_dtype = torch.float16 if device.type == "cuda" else None
    alphas = sorted({float(value) for value in args.alphas.split(",")})
    if not alphas or 0.0 not in alphas or any(value < 0 or value > 1 for value in alphas):
        raise SystemExit("alphas must include 0 and stay in [0,1]")
    base_state = base["model"]
    specialist_state = specialist["model"]
    selection_results: list[dict[str, Any]] = []
    for alpha in alphas:
        state = merged_state(base_state, specialist_state, alpha)
        metrics = evaluate_state(
            state, cfg, selection_items, device, amp_dtype,
            args.preference_weight, args.causal_margin,
        )
        selection_results.append({"alpha": alpha, "metrics": metrics})
        print(json.dumps({"alpha": alpha, **metrics}, sort_keys=True), flush=True)
    baseline = next(item["metrics"] for item in selection_results if item["alpha"] == 0.0)
    for result in selection_results:
        metrics = result["metrics"]
        result["chosen_nats_gain"] = baseline["chosen_nats_per_token"] - metrics["chosen_nats_per_token"]
        result["causal_advantage_gain"] = metrics["mean_causal_advantage"] - baseline["mean_causal_advantage"]
        result["pair_accuracy_gain"] = metrics["pair_accuracy"] - baseline["pair_accuracy"]
        result["eligible"] = (
            metrics["chosen_nats_per_token"] <= baseline["chosen_nats_per_token"] * (1 + args.max_chosen_regression)
            and result["causal_advantage_gain"] >= 0
            and result["pair_accuracy_gain"] >= 0
        )
        relative_regression = max(
            (metrics["chosen_nats_per_token"] - baseline["chosen_nats_per_token"])
            / max(baseline["chosen_nats_per_token"], 1e-12),
            0.0,
        )
        result["score"] = (
            result["causal_advantage_gain"]
            + 0.25 * result["pair_accuracy_gain"]
            - relative_regression
        )
    eligible = [item for item in selection_results if item["eligible"]]
    chosen = max(eligible, key=lambda item: (item["score"], -item["alpha"]))
    chosen_alpha = float(chosen["alpha"])
    chosen_state = merged_state(base_state, specialist_state, chosen_alpha)
    final_baseline = evaluate_state(
        base_state, cfg, final_items, device, amp_dtype,
        args.preference_weight, args.causal_margin,
    )
    final_chosen = evaluate_state(
        chosen_state, cfg, final_items, device, amp_dtype,
        args.preference_weight, args.causal_margin,
    )
    export_path = output / "archie-causal-merge.pt"
    torch.save({
        "schema": "archie-scratch-hybrid-model/v1", "config": asdict(cfg),
        "model": chosen_state, "tokenizer": base["tokenizer"],
    }, export_path)
    receipt = {
        "schema": SCHEMA,
        "method": "temporally-nested-causal-task-vector-line-search/v1",
        "models": {
            "base": {"path": str(base_path), "sha256": sha256_file(base_path)},
            "specialist": {"path": str(specialist_path), "sha256": sha256_file(specialist_path)},
            "selected": {"path": str(export_path), "sha256": sha256_file(export_path), "alpha": chosen_alpha},
            "parameters": parameter_count(ArchieHybridLM(cfg)),
        },
        "data": {
            "receipt_digest": data_receipt["receipt_digest"],
            "development_sha256": sha256_file(data_path),
            "selection_commit_groups": len({row["commit"] for row in selection_rows}),
            "selection_episodes": len(selection_items),
            "final_commit_groups": len({row["commit"] for row in final_rows}),
            "final_episodes": len(final_items),
            "final_is_newer_than_selection": max(row["order"] for row in selection_rows) < min(row["order"] for row in final_rows),
        },
        "selection": {
            "alphas": alphas, "max_chosen_regression": args.max_chosen_regression,
            "results": selection_results, "selected_alpha": chosen_alpha,
        },
        "final_temporal_holdout": {
            "base": final_baseline, "selected": final_chosen,
            "chosen_nats_gain": final_baseline["chosen_nats_per_token"] - final_chosen["chosen_nats_per_token"],
            "causal_advantage_gain": final_chosen["mean_causal_advantage"] - final_baseline["mean_causal_advantage"],
            "pair_accuracy_gain": final_chosen["pair_accuracy"] - final_baseline["pair_accuracy"],
        },
        "promotion": "selected-merge" if chosen_alpha > 0 else "base-retained-no-safe-merge",
        "claim_boundary": "The merge alpha was selected only on the earlier half of development history and reported once on the newer half. This remains repository-specific evidence, not general capability admission.",
    }
    receipt["receipt_digest"] = digest(receipt)
    atomic_json(output / "merge-receipt.json", receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--specialist-model", required=True)
    parser.add_argument("--development-data", required=True)
    parser.add_argument("--data-receipt", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--alphas", default="0,0.0625,0.125,0.25,0.5,0.75,1")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-seq-length", type=int, default=640)
    parser.add_argument("--max-target-tokens", type=int, default=256)
    parser.add_argument("--preference-weight", type=float, default=1.5)
    parser.add_argument("--causal-margin", type=float, default=0.1)
    parser.add_argument("--max-chosen-regression", type=float, default=0.005)
    args = parser.parse_args()
    receipt = search(args)
    print(json.dumps({
        "promotion": receipt["promotion"],
        "selected": receipt["models"]["selected"],
        "final_temporal_holdout": receipt["final_temporal_holdout"],
        "receipt_digest": receipt["receipt_digest"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
