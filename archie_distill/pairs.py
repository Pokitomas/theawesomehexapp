from __future__ import annotations

import pathlib
from typing import Any

from .core import (
    SCHEMA_PREFERENCE_DATASET,
    estimated_tokens,
    normalize_answer,
    read_jsonl,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
    write_jsonl,
)

PAIR_SCHEMA = "archie-causal-preference-pair/v1"


def _messages(row: dict[str, Any]) -> list[dict[str, str]]:
    supplied = row.get("messages")
    if isinstance(supplied, list) and supplied:
        messages = [
            {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
            for item in supplied
            if isinstance(item, dict) and str(item.get("content") or "").strip()
        ]
        if messages:
            return messages
    prompt = str(row.get("prompt") or row.get("instruction") or "").strip()
    if not prompt:
        raise ValueError(f"Row {row.get('id', '<unknown>')} has no prompt/messages")
    return [{"role": "user", "content": prompt}]


def _pair(
    *,
    pair_id_seed: str,
    group_id: str,
    messages: list[dict[str, str]],
    chosen: str,
    rejected: str,
    evidence_weight: float,
    source: str,
    task_type: str,
    provenance: dict[str, Any],
) -> dict[str, Any]:
    if not chosen.strip() or not rejected.strip():
        raise ValueError("Preference pair answers must be non-empty")
    if normalize_answer(chosen) == normalize_answer(rejected):
        raise ValueError("Preference pair answers must differ after normalization")
    body = {
        "schema": PAIR_SCHEMA,
        "pair_id": f"pair_{sha256_text(pair_id_seed)[:32]}",
        "group_id": group_id,
        "messages": messages,
        "chosen": chosen,
        "rejected": rejected,
        "evidence_weight": max(0.25, min(4.0, float(evidence_weight))),
        "source": source,
        "task_type": task_type,
        "provenance": provenance,
    }
    body["token_cost"] = estimated_tokens(stable_json(messages)) + estimated_tokens(chosen) + estimated_tokens(rejected)
    body["pair_digest"] = sha256_text(stable_json(body))
    return body


def pairs_from_dataset(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        chosen = str(row.get("answer") or "").strip()
        if not chosen:
            continue
        messages = _messages(row)
        row_id = str(row.get("id") or f"dataset-{index:08d}")
        task_type = str(row.get("task_type") or "text")
        for rejection_index, rejection in enumerate(row.get("rejected_answers") or []):
            if isinstance(rejection, dict):
                rejected = str(rejection.get("answer") or "").strip()
                teacher_id = str(rejection.get("teacher_id") or "unknown")
                confidence = rejection.get("confidence")
            else:
                rejected = str(rejection).strip()
                teacher_id = "unknown"
                confidence = None
            if not rejected or normalize_answer(chosen) == normalize_answer(rejected):
                continue
            weight = 1.0 + min(1.0, max(0.0, float(row.get("teacher_count", 1)) - 1.0) * 0.25)
            if confidence is not None:
                weight += min(0.5, max(0.0, float(confidence)) * 0.5)
            pairs.append(_pair(
                pair_id_seed=f"teacher:{row_id}:{rejection_index}:{sha256_text(rejected)}",
                group_id=f"prompt:{row_id}",
                messages=messages,
                chosen=chosen,
                rejected=rejected,
                evidence_weight=weight,
                source="teacher-disagreement",
                task_type=task_type,
                provenance={
                    "dataset_id": row_id,
                    "chosen_sha256": sha256_text(chosen),
                    "rejected_sha256": sha256_text(rejected),
                    "rejected_teacher_id": teacher_id,
                },
            ))
    return pairs


def pairs_from_repairs(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        verified = row.get("verified") is True
        verification = row.get("verification")
        if isinstance(verification, dict):
            verified = verified or str(verification.get("status") or "").casefold() == "passed"
        if not verified:
            continue
        rejected = str(row.get("failed_answer") or row.get("rejected") or "").strip()
        chosen = str(row.get("repaired_answer") or row.get("chosen") or "").strip()
        if not rejected or not chosen or normalize_answer(chosen) == normalize_answer(rejected):
            continue
        messages = _messages(row)
        row_id = str(row.get("id") or f"repair-{index:08d}")
        positive = row.get("positive_evidence") or row.get("verification_digests") or []
        negative = row.get("negative_evidence") or row.get("negative_evidence_digests") or []
        evidence_weight = 1.0 + 0.5 * len(positive) + 0.25 * len(negative)
        pairs.append(_pair(
            pair_id_seed=f"repair:{row_id}:{sha256_text(rejected)}:{sha256_text(chosen)}",
            group_id=str(row.get("group_id") or f"repair:{row_id}"),
            messages=messages,
            chosen=chosen,
            rejected=rejected,
            evidence_weight=evidence_weight,
            source="verified-failed-to-repair",
            task_type=str(row.get("task_type") or "text"),
            provenance={
                "repair_id": row_id,
                "parent_digest": row.get("parent_digest") or row.get("parent_trajectory_digest"),
                "repair_digest": row.get("repair_digest") or row.get("repair_trajectory_digest"),
                "positive_evidence": sorted(str(item) for item in positive),
                "negative_evidence": sorted(str(item) for item in negative),
            },
        ))
    return pairs


def information_budgeted_select(pairs: list[dict[str, Any]], *, max_tokens: int) -> list[dict[str, Any]]:
    deduplicated: dict[str, dict[str, Any]] = {}
    for pair in pairs:
        digest = str(pair["pair_digest"])
        prior = deduplicated.get(digest)
        if prior is not None and stable_json(prior) != stable_json(pair):
            raise ValueError(f"Conflicting pair digest {digest}")
        deduplicated[digest] = pair
    ordered = sorted(
        deduplicated.values(),
        key=lambda pair: (
            -float(pair.get("evidence_weight", 1.0)) / max(1, int(pair.get("token_cost", 1))),
            str(pair.get("source", "")),
            str(pair.get("pair_id", "")),
        ),
    )
    if max_tokens <= 0:
        return ordered
    selected: list[dict[str, Any]] = []
    spent = 0
    represented: set[str] = set()
    for pair in ordered:
        bucket = f"{pair.get('task_type')}:{pair.get('source')}"
        cost = int(pair.get("token_cost", 1))
        if bucket in represented or spent + cost > max_tokens:
            continue
        selected.append(pair)
        represented.add(bucket)
        spent += cost
    selected_ids = {str(pair["pair_id"]) for pair in selected}
    for pair in ordered:
        if str(pair["pair_id"]) in selected_ids:
            continue
        cost = int(pair.get("token_cost", 1))
        if spent + cost > max_tokens:
            continue
        selected.append(pair)
        selected_ids.add(str(pair["pair_id"]))
        spent += cost
    return selected


def deterministic_split(
    pairs: list[dict[str, Any]], *, seed: int, holdout_rate: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not 0.0 <= holdout_rate < 1.0:
        raise ValueError("holdout_rate must be in [0,1)")
    train: list[dict[str, Any]] = []
    development: list[dict[str, Any]] = []
    for pair in sorted(pairs, key=lambda item: str(item["pair_id"])):
        unit = int(sha256_text(f"{seed}:{pair['group_id']}")[:13], 16) / 0x1FFFFFFFFFFFFF
        (development if unit < holdout_rate else train).append(pair)
    if not train and development:
        train.append(development.pop(0))
    return train, development


def configure_parser(parser: Any) -> None:
    parser.add_argument("--dataset", action="append", default=[])
    parser.add_argument("--repairs", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--holdout-rate", type=float, default=0.2)
    parser.add_argument("--max-replay-tokens", type=int, default=0)


def run_from_args(args: Any) -> dict[str, Any]:
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    dataset_paths = [pathlib.Path(item).resolve() for item in args.dataset]
    repair_paths = [pathlib.Path(item).resolve() for item in args.repairs]
    if not dataset_paths and not repair_paths:
        raise SystemExit("At least one --dataset or --repairs file is required")
    pairs: list[dict[str, Any]] = []
    for path in dataset_paths:
        pairs.extend(pairs_from_dataset(read_jsonl(path)))
    for path in repair_paths:
        pairs.extend(pairs_from_repairs(read_jsonl(path)))
    selected = information_budgeted_select(pairs, max_tokens=int(args.max_replay_tokens))
    if not selected:
        raise SystemExit("No usable preference pairs were compiled")
    train, development = deterministic_split(selected, seed=int(args.seed), holdout_rate=float(args.holdout_rate))
    output.mkdir(parents=True)
    train_path = output / "preference.train.jsonl"
    development_path = output / "preference.development.jsonl"
    write_jsonl(train_path, train)
    write_jsonl(development_path, development)
    receipt: dict[str, Any] = {
        "schema": SCHEMA_PREFERENCE_DATASET,
        "method": "sanitized-teacher-disagreement-plus-verified-repair-information-budget/v1",
        "seed": int(args.seed),
        "holdout_rate": float(args.holdout_rate),
        "max_replay_tokens": int(args.max_replay_tokens),
        "inputs": {
            "datasets": [{"path": str(path), "sha256": sha256_file(path)} for path in dataset_paths],
            "repairs": [{"path": str(path), "sha256": sha256_file(path)} for path in repair_paths],
        },
        "counts": {
            "compiled": len(pairs),
            "selected": len(selected),
            "train": len(train),
            "development": len(development),
        },
        "selected_token_cost": sum(int(item["token_cost"]) for item in selected),
        "pair_digests": [item["pair_digest"] for item in sorted(selected, key=lambda row: str(row["pair_id"]))],
        "claim_boundary": "This proves deterministic final-answer preference compilation and replay budgeting, not neural improvement.",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "preference-receipt.json", receipt)
    return receipt
