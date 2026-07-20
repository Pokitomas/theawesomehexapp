#!/usr/bin/env python3
"""Select a deterministic, balanced, low-correlation Kimi smoke pack."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from kimi_distill_common import (
    FAILURES,
    ROUTES,
    canon,
    digest,
    expected,
    first_present,
    load,
    source_row,
    user_text,
)

FAMILIES = FAILURES
SECURITY_TERMS = {
    "security", "webcam", "microphone", "camera", "login", "authentication",
    "credential", "receipt", "permission", "memory", "sandbox", "status indicator",
}


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def jaccard(first: Any, second: Any) -> float:
    left = {token for token in canon(first).split() if not token.isdigit()}
    right = {token for token in canon(second).split() if not token.isdigit()}
    return len(left & right) / max(1, len(left | right))


def explicit_family(row: dict[str, Any]) -> str | None:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    for value in (row.get("failure_family"), row.get("category"), metadata.get("failure_family")):
        if value in FAMILIES:
            return value
    return None


def infer_family(row: dict[str, Any]) -> str | None:
    direct = explicit_family(row)
    if direct:
        return direct
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    category = str(row.get("category") or metadata.get("category") or "").lower()
    labels = expected(row)
    route = labels["route"]
    text = user_text(row).lower()
    if category == "negation":
        return "negation-and-correction-clause-activity"
    if category in {"ordered-multi", "compound"}:
        return "punctuation-and-before-compounds"
    if category in {"abstention", "vague-reference"}:
        return "vague-reference-abstention"
    if category in {"memory", "memory-conflict"}:
        return "memory-operation-conflict"
    if category in {"authority-control", "security-documentation"} and labels["authority"] == "allow":
        return "safe-security-documentation"
    if category == "conversational" and route in {"summary", "decision"}:
        return "unseen-summary-decision-phrasing"
    if labels["authority"] == "allow" and route != "clarify" and any(term in text for term in SECURITY_TERMS):
        return "safe-security-documentation"
    return None


def provenance_key(row: dict[str, Any]) -> str | None:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    for key in ("source_group", "origin_id", "template_id", "cluster_id", "source_id"):
        value = first_present(row, (key,), None)
        if value is None:
            value = first_present(metadata, (key,), None)
        if value is not None and str(value).strip():
            return f"{key}:{value}"
    return None


def normalized_row(row: dict[str, Any], family: str) -> dict[str, Any]:
    source = source_row({**row, "failure_family": family})
    if source is None:
        raise ValueError("row does not satisfy the Archie teacher-source contract")
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    return {
        "id": row.get("id") or digest({"prompt": source["prompt"], "family": family})[:16],
        "failure_family": family,
        "prompt": source["prompt"],
        "route": source["route"],
        "authority": source["authority"],
        "context": source["context"],
        "context_state": source["context"],
        "transform_type": first_present(row, ("transform_type",), metadata.get("transform_type") or "direct"),
        "outcomes": source["outcomes"],
        "attachments": source["attachments"],
        "memory": source["memory"],
        "thread": source["thread"],
        "source_digest": digest(row),
        "provenance_key": provenance_key(row),
    }


def independent_candidates(
    rows: list[dict[str, Any]], max_similarity: float
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    selected: list[dict[str, Any]] = []
    provenance: set[str] = set()
    counts = {"exact_duplicates": 0, "shared_provenance": 0, "near_duplicates": 0}
    exact: set[str] = set()
    for row in rows:
        identity = digest(
            {
                "prompt": canon(row["prompt"]),
                "route": row["route"],
                "authority": row["authority"],
                "context": row["context"],
                "outcomes": row["outcomes"],
            }
        )
        if identity in exact:
            counts["exact_duplicates"] += 1
            continue
        exact.add(identity)
        key = row.get("provenance_key")
        if key and key in provenance:
            counts["shared_provenance"] += 1
            continue
        if any(jaccard(row["prompt"], existing["prompt"]) >= max_similarity for existing in selected):
            counts["near_duplicates"] += 1
            continue
        selected.append(row)
        if key:
            provenance.add(key)
    return selected, counts


def select(
    rows: list[dict[str, Any]], per_family: int, seed: int, max_similarity: float = 0.84
) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if not isinstance(row, dict):
            continue
        family = infer_family(row)
        prompt = user_text(row)
        labels = expected(row)
        if not family or not prompt or labels["route"] not in ROUTES:
            continue
        try:
            normalized = normalized_row(row, family)
        except ValueError:
            continue
        buckets[family].append(normalized)

    selected: list[dict[str, Any]] = []
    missing = {}
    for family in FAMILIES:
        candidates = buckets[family]
        candidates.sort(
            key=lambda row: digest(
                {"seed": seed, "family": family, "id": row["id"], "prompt": row["prompt"]}
            )
        )
        independent, rejection_counts = independent_candidates(candidates, max_similarity)
        if len(independent) < per_family:
            missing[family] = {
                "required": per_family,
                "raw": len(candidates),
                "independent": len(independent),
                "correlation_rejections": rejection_counts,
            }
        selected.extend(independent[:per_family])
    if missing:
        raise RuntimeError(f"insufficient independent smoke sources: {stable_json(missing)}")
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--per-family", type=int, default=16)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--max-similarity", type=float, default=0.84)
    args = parser.parse_args()
    if args.per_family < 1:
        raise ValueError("--per-family must be positive")
    if not 0 <= args.max_similarity <= 1:
        raise ValueError("--max-similarity must be between 0 and 1")
    rows = [row for path in args.data for row in load(path)]
    selected = select(rows, args.per_family, args.seed, args.max_similarity)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(selected, indent=2, ensure_ascii=False) + "\n")
    body = {
        "schema": "archie-kimi-smoke-selection/v3",
        "seed": args.seed,
        "per_family": args.per_family,
        "max_similarity": args.max_similarity,
        "examples": len(selected),
        "family_counts": {
            family: sum(row["failure_family"] == family for row in selected)
            for family in FAMILIES
        },
        "source_files": [
            {"path": path, "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}
            for path in args.data
        ],
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "promotion": "not-admitted",
        "claim_boundary": (
            "Balanced low-correlation teacher-source selection only; no API, training, evaluation, "
            "or admission claim."
        ),
    }
    receipt = {**body, "receipt_digest": digest(body)}
    Path(str(output) + ".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
