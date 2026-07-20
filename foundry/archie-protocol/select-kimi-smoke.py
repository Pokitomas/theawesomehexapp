#!/usr/bin/env python3
"""Select a deterministic, balanced Kimi isolation smoke pack."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

FAMILIES = [
    "unseen-summary-decision-phrasing",
    "safe-security-documentation",
    "memory-operation-conflict",
    "punctuation-and-before-compounds",
    "vague-reference-abstention",
    "negation-and-correction-clause-activity",
]
ROUTES = {
    "checklist", "clarify", "compound", "decision", "errands", "event",
    "message", "next_action", "objective", "plan", "study", "summary",
}
SECURITY_TERMS = {
    "security", "webcam", "microphone", "camera", "login", "authentication",
    "credential", "receipt", "permission", "memory", "sandbox", "status indicator",
}


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode()).hexdigest()


def load(path: str) -> list[dict[str, Any]]:
    file = Path(path)
    if file.suffix == ".jsonl":
        return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
    value = json.loads(file.read_text())
    return value if isinstance(value, list) else value.get("rows", [])


def user_text(row: dict[str, Any]) -> str:
    for key in ("prompt", "request", "text"):
        if isinstance(row.get(key), str) and row[key].strip():
            return row[key].strip()
    for message in row.get("messages") or []:
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return message["content"].strip()
    return ""


def expected(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("expected") if isinstance(row.get("expected"), dict) else {}
    return {
        "route": row.get("route") or value.get("route"),
        "authority": row.get("authority") or value.get("authority", "allow"),
        "context": row.get("context") or value.get("context", "ready"),
        "outcomes": row.get("outcomes") or value.get("outcomes", []),
    }


def explicit_family(row: dict[str, Any]) -> str | None:
    for value in (row.get("failure_family"), row.get("category"), (row.get("metadata") or {}).get("failure_family")):
        if value in FAMILIES:
            return value
    return None


def infer_family(row: dict[str, Any]) -> str | None:
    direct = explicit_family(row)
    if direct:
        return direct
    category = str(row.get("category") or (row.get("metadata") or {}).get("category") or "").lower()
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


def normalized_row(row: dict[str, Any], family: str) -> dict[str, Any]:
    labels = expected(row)
    prompt = user_text(row)
    return {
        "id": row.get("id") or digest({"prompt": prompt, "family": family})[:16],
        "failure_family": family,
        "prompt": prompt,
        "route": labels["route"],
        "authority": labels["authority"],
        "context": labels["context"],
        "outcomes": labels["outcomes"],
        "attachments": row.get("attachments") or row.get("files") or [],
        "memory": row.get("memory") or "",
        "thread": row.get("thread") or row.get("reply_to") or "",
        "source_digest": digest(row),
    }


def select(rows: list[dict[str, Any]], per_family: int, seed: int) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        family = infer_family(row)
        prompt = user_text(row)
        labels = expected(row)
        if not family or not prompt or labels["route"] not in ROUTES:
            continue
        normalized = normalized_row(row, family)
        identity = digest({"prompt": " ".join(prompt.lower().split()), "labels": labels})
        buckets[family].setdefault(identity, normalized)
    selected: list[dict[str, Any]] = []
    missing = {}
    for family in FAMILIES:
        candidates = list(buckets[family].values())
        candidates.sort(key=lambda row: digest({"seed": seed, "family": family, "id": row["id"], "prompt": row["prompt"]}))
        if len(candidates) < per_family:
            missing[family] = {"required": per_family, "available": len(candidates)}
        selected.extend(candidates[:per_family])
    if missing:
        raise RuntimeError(f"insufficient independent smoke sources: {stable_json(missing)}")
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--per-family", type=int, default=16)
    parser.add_argument("--seed", type=int, default=3407)
    args = parser.parse_args()
    rows = [row for path in args.data for row in load(path)]
    selected = select(rows, args.per_family, args.seed)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(selected, indent=2, ensure_ascii=False) + "\n")
    body = {
        "schema": "archie-kimi-smoke-selection/v1",
        "seed": args.seed,
        "per_family": args.per_family,
        "examples": len(selected),
        "family_counts": {family: sum(row["failure_family"] == family for row in selected) for family in FAMILIES},
        "source_files": [{"path": path, "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()} for path in args.data],
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "promotion": "not-admitted",
        "claim_boundary": "Balanced teacher-source selection only; no API, training, evaluation, or admission claim.",
    }
    receipt = {**body, "receipt_digest": digest(body)}
    Path(str(output) + ".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
