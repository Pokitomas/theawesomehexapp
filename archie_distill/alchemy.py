from __future__ import annotations

import pathlib
from typing import Any

from .core import (
    SCHEMA_CONFIG,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
    write_jsonl,
)

SCHEMA_ALCHEMY = "archie-fork-repair-sft/v1"


def common_prefix_length(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def recovery_depths(divergence: int, failed_length: int, requested: int) -> list[int]:
    if failed_length <= 0 or requested <= 0:
        return []
    start = min(max(0, divergence), failed_length - 1)
    if requested == 1:
        return [start]
    span = max(1, failed_length - start - 1)
    depths = {
        min(failed_length - 1, start + round(span * index / (requested - 1)))
        for index in range(requested)
    }
    return sorted(depths)


def _clean_messages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("Repair row has no messages")
    messages = [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in value
        if isinstance(item, dict) and str(item.get("content") or "").strip()
    ]
    if not messages:
        raise ValueError("Repair row has no usable messages")
    return messages


def compile_repair(tokenizer: Any, row: dict[str, Any], *, recovery_views: int) -> list[dict[str, Any]]:
    messages = _clean_messages(row.get("messages"))
    failed = str(row.get("failed_answer") or "").strip()
    repaired = str(row.get("repaired_answer") or "").strip()
    if not failed or not repaired or failed == repaired:
        return []

    failed_ids = tokenizer(failed, add_special_tokens=False)["input_ids"]
    repaired_ids = tokenizer(repaired, add_special_tokens=False)["input_ids"]
    divergence = common_prefix_length(failed_ids, repaired_ids)
    source_id = str(row.get("id") or sha256_text(stable_json(row))[:24])
    task_type = str(row.get("task_type") or "text")
    provenance = {
        "source_repair_id": source_id,
        "source_repair_sha256": sha256_text(stable_json(row)),
        "divergence_token": divergence,
        "failed_tokens": len(failed_ids),
        "repaired_tokens": len(repaired_ids),
    }

    lessons: list[dict[str, Any]] = [{
        "id": f"alchemy_clean_{source_id}",
        "split": "train",
        "messages": messages,
        "answer": repaired,
        "task_type": task_type,
        "lesson_type": "clean-repair-anchor",
        "provenance": provenance,
    }]

    if divergence < len(repaired_ids):
        shared_prefix = tokenizer.decode(repaired_ids[:divergence], skip_special_tokens=True).strip()
        target_suffix = tokenizer.decode(repaired_ids[divergence:], skip_special_tokens=True).strip()
        if target_suffix:
            lessons.append({
                "id": f"alchemy_divergence_{source_id}",
                "split": "train",
                "messages": [
                    *messages,
                    {
                        "role": "user",
                        "content": (
                            "Continue the answer from this verified prefix. Do not repeat the prefix. "
                            "Return only the remaining corrected continuation.\n\n"
                            f"Verified prefix:\n{shared_prefix}"
                        ),
                    },
                ],
                "answer": target_suffix,
                "task_type": task_type,
                "lesson_type": "exact-divergence-continuation",
                "provenance": provenance,
            })

    for depth in recovery_depths(divergence, len(failed_ids), recovery_views):
        flawed_prefix = tokenizer.decode(failed_ids[: depth + 1], skip_special_tokens=True).strip()
        if not flawed_prefix:
            continue
        lessons.append({
            "id": f"alchemy_recovery_{source_id}_{depth:06d}",
            "split": "train",
            "messages": [
                *messages,
                {
                    "role": "user",
                    "content": (
                        "A smaller model produced the flawed partial answer below. Ignore its commitment, "
                        "recover from the mistake, and return only the complete corrected final answer.\n\n"
                        f"Flawed partial answer:\n{flawed_prefix}"
                    ),
                },
            ],
            "answer": repaired,
            "task_type": task_type,
            "lesson_type": "self-prefix-recovery",
            "recovery_depth_token": depth,
            "provenance": provenance,
        })
    return lessons


def deterministic_cap(rows: list[dict[str, Any]], *, max_rows: int, seed: int) -> list[dict[str, Any]]:
    ordered = sorted(
        rows,
        key=lambda row: (
            sha256_text(f"{seed}:{row.get('id')}"),
            str(row.get("id")),
        ),
    )
    return ordered if max_rows <= 0 else ordered[:max_rows]


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--repairs", action="append", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    repair_paths = [pathlib.Path(item).resolve() for item in args.repairs]
    model_dir = pathlib.Path(args.model).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if not model_dir.is_dir():
        raise SystemExit(f"Local student checkpoint is missing: {model_dir}")

    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    cfg = config.get("alchemy") or {}
    seed = int(config.get("seed", 0))
    recovery_views = max(1, int(cfg.get("recovery_views", 4)))
    max_rows = int(cfg.get("max_rows", 0))

    try:
        from transformers import AutoTokenizer
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before compiling fork-repair curriculum") from exc
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)

    repairs: list[dict[str, Any]] = []
    lessons: list[dict[str, Any]] = []
    for path in repair_paths:
        current = read_jsonl(path)
        repairs.extend(current)
        for row in current:
            lessons.extend(compile_repair(tokenizer, row, recovery_views=recovery_views))
    lessons = deterministic_cap(lessons, max_rows=max_rows, seed=seed)
    if not lessons:
        raise SystemExit("No fork-repair SFT lessons were compiled")

    output.mkdir(parents=True)
    dataset_path = output / "fork-repair-sft.jsonl"
    write_jsonl(dataset_path, lessons)
    counts: dict[str, int] = {}
    for row in lessons:
        kind = str(row.get("lesson_type") or "unknown")
        counts[kind] = counts.get(kind, 0) + 1
    receipt: dict[str, Any] = {
        "schema": SCHEMA_ALCHEMY,
        "method": "student-fork-exact-divergence-and-prefix-recovery-sft/v1",
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "model": {"path": str(model_dir)},
        "inputs": [{"path": str(path), "sha256": sha256_file(path)} for path in repair_paths],
        "recovery_views": recovery_views,
        "max_rows": max_rows,
        "counts": {"repairs": len(repairs), "lessons": len(lessons), "by_type": counts},
        "dataset": {"path": str(dataset_path), "sha256": sha256_file(dataset_path)},
        "training_contract": "Feed fork-repair-sft.jsonl directly to the unchanged CUDA NF4 QLoRA SFT trainer.",
        "claim_boundary": "This compiles a denser student-distribution curriculum; it does not prove neural improvement.",
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "fork-repair-receipt.json", receipt)
    return receipt
