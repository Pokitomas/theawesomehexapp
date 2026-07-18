#!/usr/bin/env python3
"""Deterministically shard verified causal pairs by actual tokenizer cost.

This is the CPU/data half of Archie segmented tokenized distillation. It does
not train weights. It validates the causal-pair receipt, tokenizes every pair
with the pinned student tokenizer, preserves repair lineages, balances token
work across shards, and optionally prioritizes evaluator-proven quantization
failures for the next bounded round.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
from collections import defaultdict
from typing import Any, Iterable

PAIR_SCHEMA = "archie-causal-divergence-pair/v1"
PAIR_RECEIPT_SCHEMA = "archie-causal-divergence-dataset-receipt/v1"
SEGMENTATION_SCHEMA = "archie-segmented-tokenized-distillation-receipt/v1"
SHARD_SCHEMA = "archie-segmented-tokenized-shard-receipt/v1"
QUANT_FAILURE_SCHEMA = "archie-quantization-failure-set/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"
TOKENIZER_FILENAMES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.json",
    "merges.txt",
    "chat_template.jinja",
)


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def stable(value: Any) -> str:
    return json.dumps(canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    if isinstance(value, bytes):
        payload = value
    elif isinstance(value, str):
        payload = value.encode("utf-8")
    else:
        payload = stable(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def file_sha256(path: pathlib.Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            hasher.update(block)
    return hasher.hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    return value


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise SystemExit(f"{path}:{index} must contain a JSON object.")
        rows.append(value)
    return rows


def write_jsonl(path: pathlib.Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text("".join(f"{stable(row)}\n" for row in rows), encoding="utf-8")


def verify_embedded_digest(value: dict[str, Any], field: str = "receipt_digest") -> str:
    claimed = str(value.get(field) or "").lower()
    if len(claimed) != 64 or any(character not in "0123456789abcdef" for character in claimed):
        raise SystemExit(f"{field} must be a SHA-256 digest.")
    body = dict(value)
    body.pop(field, None)
    if digest(body) != claimed:
        raise SystemExit(f"{field} mismatch.")
    return claimed


def prompt_text(tokenizer: Any, row: dict[str, Any]) -> str:
    instruction = str(row.get("instruction") or "").strip()
    if not instruction:
        raise SystemExit(f"Pair {row.get('pair_id', '<unknown>')} has no instruction.")
    context = row.get("compact_context")
    user = instruction if context in (None, {}, []) else f"{instruction}\n\nContext:\n{stable(context)}"
    messages = [
        {"role": "system", "content": "You are Archie. Produce typed, permission-aware plans grounded in verifiable evidence."},
        {"role": "user", "content": user},
    ]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages) + "\n<assistant>\n"


def common_prefix_length(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def tokenize_metadata(tokenizer: Any, row: dict[str, Any]) -> dict[str, Any]:
    if row.get("schema") != PAIR_SCHEMA:
        raise SystemExit(f"Unsupported pair schema for {row.get('pair_id', '<unknown>')}.")
    chosen = str(row.get("chosen_target") or "")
    rejected = str(row.get("rejected_target") or "")
    if not chosen or not rejected or chosen == rejected:
        raise SystemExit(f"Pair {row.get('pair_id')} must contain distinct chosen and rejected targets.")
    prompt_ids = tokenizer(prompt_text(tokenizer, row), add_special_tokens=False)["input_ids"]
    chosen_ids = tokenizer(chosen, add_special_tokens=False)["input_ids"]
    rejected_ids = tokenizer(rejected, add_special_tokens=False)["input_ids"]
    divergence = common_prefix_length(chosen_ids, rejected_ids)
    if divergence >= min(len(chosen_ids), len(rejected_ids)):
        raise SystemExit(f"Pair {row.get('pair_id')} has no causal divergence before one target ends.")
    token_cost = len(prompt_ids) + len(chosen_ids) + len(rejected_ids)
    return {
        "pair_id": row.get("pair_id"),
        "pair_digest": row.get("pair_digest"),
        "group_id": row.get("group_id") or f"pair:{row.get('pair_id')}",
        "prompt_tokens": len(prompt_ids),
        "chosen_tokens": len(chosen_ids),
        "rejected_tokens": len(rejected_ids),
        "divergence_target_token": divergence,
        "token_cost": token_cost,
        "evidence_weight": float(row.get("evidence_weight", 1.0)),
    }


def tokenizer_identity(tokenizer_dir: pathlib.Path, tokenizer: Any) -> dict[str, Any]:
    files = []
    for name in TOKENIZER_FILENAMES:
        path = tokenizer_dir / name
        if path.is_file():
            files.append({"path": name, "bytes": path.stat().st_size, "sha256": file_sha256(path)})
    if not files:
        raise SystemExit(f"No tokenizer artifact was found under {tokenizer_dir}.")
    body = {
        "directory": str(tokenizer_dir),
        "class": type(tokenizer).__name__,
        "vocab_size": int(getattr(tokenizer, "vocab_size", 0) or 0),
        "eos_token_id": getattr(tokenizer, "eos_token_id", None),
        "pad_token_id": getattr(tokenizer, "pad_token_id", None),
        "files": files,
    }
    return {**body, "identity_digest": digest(body)}


def load_quant_failures(path: pathlib.Path | None, *, expected_round: int) -> tuple[dict[str, float], dict[str, Any] | None]:
    if path is None:
        return {}, None
    value = read_json(path)
    if value.get("schema") != QUANT_FAILURE_SCHEMA:
        raise SystemExit(f"{path} is not an Archie quantization failure set v1.")
    verify_embedded_digest(value)
    if int(value.get("next_round", -1)) != expected_round:
        raise SystemExit(f"Quantization failure set targets round {value.get('next_round')}, not {expected_round}.")
    priorities: dict[str, float] = {}
    for index, item in enumerate(value.get("failures", [])):
        if not isinstance(item, dict):
            raise SystemExit(f"failures[{index}] must be an object.")
        pair_id = str(item.get("pair_id") or "").strip()
        severity = float(item.get("severity", 0))
        if not pair_id or not 0 < severity <= 4:
            raise SystemExit(f"failures[{index}] requires pair_id and severity in (0,4].")
        priorities[pair_id] = max(priorities.get(pair_id, 0.0), severity)
    return priorities, value


def build_shards(
    train_rows: list[dict[str, Any]],
    development_rows: list[dict[str, Any]],
    tokenizer: Any,
    *,
    shard_count: int,
    seed: int,
    round_number: int,
    quant_priorities: dict[str, float] | None = None,
) -> dict[str, Any]:
    if shard_count < 1:
        raise SystemExit("shard_count must be positive.")
    if not train_rows:
        raise SystemExit("Segmented distillation requires at least one training pair.")
    if not development_rows:
        raise SystemExit("Segmented distillation requires a nonempty held-out development split.")
    quant_priorities = quant_priorities or {}
    train_meta = {str(row.get("pair_id")): tokenize_metadata(tokenizer, row) for row in train_rows}
    development_meta = {str(row.get("pair_id")): tokenize_metadata(tokenizer, row) for row in development_rows}
    if len(train_meta) != len(train_rows) or len(development_meta) != len(development_rows):
        raise SystemExit("Pair IDs must be unique within each split.")

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    rows_by_id = {str(row.get("pair_id")): row for row in train_rows}
    for metadata in train_meta.values():
        grouped[str(metadata["group_id"])].append(metadata)

    work = []
    for group_id, items in grouped.items():
        token_cost = sum(int(item["token_cost"]) for item in items)
        evidence = sum(float(item["evidence_weight"]) for item in items)
        quant_priority = max((quant_priorities.get(str(item["pair_id"]), 0.0) for item in items), default=0.0)
        boosted_cost = token_cost * max(1.0, evidence / max(1, len(items))) * (1.0 + quant_priority)
        tie = digest(f"{seed}:{round_number}:{group_id}")
        work.append({
            "group_id": group_id,
            "items": sorted(items, key=lambda item: str(item["pair_id"])),
            "token_cost": token_cost,
            "boosted_cost": boosted_cost,
            "quant_priority": quant_priority,
            "tie": tie,
        })
    work.sort(key=lambda item: (-item["quant_priority"], -item["boosted_cost"], item["tie"]))

    shards = [
        {"index": index, "load": 0.0, "raw_token_cost": 0, "groups": [], "pair_ids": []}
        for index in range(min(shard_count, len(work)))
    ]
    for group in work:
        target = min(shards, key=lambda shard: (shard["load"], shard["index"]))
        target["groups"].append(group["group_id"])
        target["pair_ids"].extend(str(item["pair_id"]) for item in group["items"])
        target["load"] += float(group["boosted_cost"])
        target["raw_token_cost"] += int(group["token_cost"])

    output_shards = []
    for shard in shards:
        pair_ids = sorted(shard["pair_ids"])
        rows = [rows_by_id[pair_id] for pair_id in pair_ids]
        metadata = [train_meta[pair_id] for pair_id in pair_ids]
        output_shards.append({
            "index": shard["index"],
            "groups": sorted(shard["groups"]),
            "pair_ids": pair_ids,
            "train_rows": rows,
            "development_rows": development_rows,
            "train_metadata": metadata,
            "development_metadata": list(development_meta.values()),
            "raw_token_cost": shard["raw_token_cost"],
            "weighted_token_cost": shard["load"],
            "quant_priority_pairs": sorted(pair_id for pair_id in pair_ids if pair_id in quant_priorities),
        })
    return {
        "shards": output_shards,
        "train_metadata": list(train_meta.values()),
        "development_metadata": list(development_meta.values()),
    }


def validate_pair_inputs(
    train_rows: list[dict[str, Any]],
    development_rows: list[dict[str, Any]],
    receipt: dict[str, Any],
) -> str:
    if receipt.get("schema") != PAIR_RECEIPT_SCHEMA:
        raise SystemExit("Unsupported causal-pair receipt schema.")
    claimed = verify_embedded_digest(receipt)
    rows = train_rows + development_rows
    observed = sorted(str(row.get("pair_digest") or "") for row in rows)
    expected = sorted(str(item) for item in receipt.get("pair_digests", []))
    if observed != expected:
        raise SystemExit("Pair bytes do not exactly match the bound causal-pair receipt.")
    counts = receipt.get("counts") or {}
    if int(counts.get("train", -1)) != len(train_rows) or int(counts.get("development", -1)) != len(development_rows):
        raise SystemExit("Causal-pair split counts do not match the receipt.")
    return claimed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--development", required=True)
    parser.add_argument("--pair-receipt", required=True)
    parser.add_argument("--tokenizer-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--shards", type=int, default=4)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--round", type=int, default=0)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--code-revision", required=True)
    parser.add_argument("--quant-failures")
    args = parser.parse_args()

    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if args.round < 0:
        raise SystemExit("round must be nonnegative.")
    request_id = str(args.request_id).strip()
    code_revision = str(args.code_revision).strip().lower()
    if not request_id:
        raise SystemExit("request-id must be nonempty.")
    if len(code_revision) != 40 or any(character not in "0123456789abcdef" for character in code_revision):
        raise SystemExit("code-revision must be a 40-character Git commit SHA.")
    train_path = pathlib.Path(args.train).resolve()
    development_path = pathlib.Path(args.development).resolve()
    pair_receipt_path = pathlib.Path(args.pair_receipt).resolve()
    tokenizer_dir = pathlib.Path(args.tokenizer_dir).resolve()
    quant_failure_path = pathlib.Path(args.quant_failures).resolve() if args.quant_failures else None

    train_rows = read_jsonl(train_path)
    development_rows = read_jsonl(development_path)
    pair_receipt = read_json(pair_receipt_path)
    pair_receipt_digest = validate_pair_inputs(train_rows, development_rows, pair_receipt)
    quant_priorities, quant_failure_receipt = load_quant_failures(quant_failure_path, expected_round=args.round)

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        from transformers import AutoTokenizer
    except Exception as exc:
        raise SystemExit("Pinned Transformers is required to tokenize segmented distillation pairs.") from exc
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer_receipt = tokenizer_identity(tokenizer_dir, tokenizer)

    result = build_shards(
        train_rows,
        development_rows,
        tokenizer,
        shard_count=args.shards,
        seed=args.seed,
        round_number=args.round,
        quant_priorities=quant_priorities,
    )
    output.mkdir(parents=True)
    shard_receipts = []
    for shard in result["shards"]:
        shard_dir = output / f"shard-{shard['index']:03d}"
        shard_dir.mkdir()
        train_out = shard_dir / "causal-preference.train.jsonl"
        development_out = shard_dir / "causal-preference.development.jsonl"
        write_jsonl(train_out, shard["train_rows"])
        write_jsonl(development_out, shard["development_rows"])
        subset_pair_body = {
            "schema": PAIR_RECEIPT_SCHEMA,
            "seed": args.seed,
            "holdout_rate": pair_receipt.get("holdout_rate"),
            "batch_digests": pair_receipt.get("batch_digests", []),
            "pair_digests": sorted([row["pair_digest"] for row in shard["train_rows"] + shard["development_rows"]]),
            "counts": {
                "total": len(shard["train_rows"]) + len(shard["development_rows"]),
                "train": len(shard["train_rows"]),
                "development": len(shard["development_rows"]),
            },
            "method": "segmented-tokenized-causal-subset/v1",
            "source_pair_receipt_digest": pair_receipt_digest,
            "request_id": request_id,
            "code_revision": code_revision,
            "round": args.round,
            "shard_index": shard["index"],
            "claim_boundary": "This receipt binds one tokenizer-balanced training subset and the common global held-out split. It does not prove neural training or model improvement.",
        }
        subset_pair_receipt = {**subset_pair_body, "receipt_digest": digest(subset_pair_body)}
        subset_pair_path = shard_dir / "causal-preference-receipt.json"
        subset_pair_path.write_text(json.dumps(subset_pair_receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        body = {
            "schema": SHARD_SCHEMA,
            "method": METHOD,
            "request_id": request_id,
            "code_revision": code_revision,
            "round": args.round,
            "shard_index": shard["index"],
            "pair_receipt_digest": pair_receipt_digest,
            "tokenizer_identity_digest": tokenizer_receipt["identity_digest"],
            "train": {
                "path": train_out.name,
                "sha256": file_sha256(train_out),
                "rows": len(shard["train_rows"]),
                "pair_ids": shard["pair_ids"],
                "pair_digests": [row["pair_digest"] for row in shard["train_rows"]],
                "raw_token_cost": shard["raw_token_cost"],
                "weighted_token_cost": shard["weighted_token_cost"],
                "groups": shard["groups"],
                "quant_priority_pairs": shard["quant_priority_pairs"],
                "metadata": shard["train_metadata"],
            },
            "causal_pair_receipt": {
                "path": subset_pair_path.name,
                "sha256": file_sha256(subset_pair_path),
                "receipt_digest": subset_pair_receipt["receipt_digest"],
            },
            "development": {
                "path": development_out.name,
                "sha256": file_sha256(development_out),
                "rows": len(shard["development_rows"]),
                "pair_digests": [row["pair_digest"] for row in shard["development_rows"]],
                "scope": "global-held-out-comparison",
                "metadata": shard["development_metadata"],
            },
            "claim_boundary": "This shard proves deterministic tokenizer-bound work partitioning. It does not prove training, tensor changes, evaluation gain, quantization retention, or admission.",
        }
        receipt = {**body, "receipt_digest": digest(body)}
        receipt_path = shard_dir / "shard-receipt.json"
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        shard_receipts.append({
            "shard_index": shard["index"],
            "directory": shard_dir.name,
            "receipt_sha256": file_sha256(receipt_path),
            "receipt_digest": receipt["receipt_digest"],
            "raw_token_cost": shard["raw_token_cost"],
            "weighted_token_cost": shard["weighted_token_cost"],
            "train_rows": len(shard["train_rows"]),
        })

    receipt_body = {
        "schema": SEGMENTATION_SCHEMA,
        "method": METHOD,
        "request_id": request_id,
        "code_revision": code_revision,
        "round": args.round,
        "seed": args.seed,
        "source": {
            "train": {"path": str(train_path), "sha256": file_sha256(train_path), "rows": len(train_rows)},
            "development": {"path": str(development_path), "sha256": file_sha256(development_path), "rows": len(development_rows)},
            "pair_receipt": {"path": str(pair_receipt_path), "sha256": file_sha256(pair_receipt_path), "receipt_digest": pair_receipt_digest},
            "quant_failure_set": {
                "path": str(quant_failure_path),
                "sha256": file_sha256(quant_failure_path),
                "receipt_digest": quant_failure_receipt["receipt_digest"],
            } if quant_failure_path and quant_failure_receipt else None,
        },
        "tokenizer": tokenizer_receipt,
        "shards": shard_receipts,
        "policy": {
            "lineage_atomic": True,
            "actual_tokenizer_cost": True,
            "largest_weighted_group_first": True,
            "global_held_out_split_on_every_shard": True,
            "quantization_failure_priority": bool(quant_priorities),
        },
        "promotion": "not-admitted",
        "claim_boundary": "Segmented tokenization completed on CPU. No gradient, adapter, capability, quantization, or admission claim is made.",
    }
    receipt = {**receipt_body, "receipt_digest": digest(receipt_body)}
    receipt_path = output / "segmentation-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
