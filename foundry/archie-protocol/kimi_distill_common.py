"""Shared contracts and context projection for Archie Kimi distillation."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping

ROUTES = [
    "checklist", "clarify", "compound", "decision", "errands", "event",
    "message", "next_action", "objective", "plan", "study", "summary",
]
AUTH = ["allow", "deny"]
CONTEXT = ["ready", "missing", "ambiguous"]
FAILURES = [
    "unseen-summary-decision-phrasing",
    "safe-security-documentation",
    "memory-operation-conflict",
    "punctuation-and-before-compounds",
    "vague-reference-abstention",
    "negation-and-correction-clause-activity",
]
STYLES = [
    "casual text message",
    "spoken request with filler words",
    "messy mobile dictation",
    "polite request",
    "urgent informal request",
    "context-dependent follow-up",
]
TOKENS = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
_MISSING = object()


def canon(value: Any) -> str:
    return " ".join(TOKENS.findall(str(value or "").lower().replace("’", "'")))


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def first_present(mapping: Mapping[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    """Return the first explicitly present, non-None value without treating empties as missing."""
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return default


def user_text(row: Mapping[str, Any]) -> str:
    for key in ("text", "prompt", "request"):
        if isinstance(row.get(key), str) and row[key].strip():
            return row[key].strip()
    for message in row.get("messages") or []:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        value = message.get("content")
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            text = " ".join(
                part.get("text", "")
                for part in value
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ).strip()
            if text:
                return text
    return ""


def load(path: str) -> list[dict[str, Any]]:
    file = Path(path)
    if file.suffix == ".jsonl":
        return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
    value = json.loads(file.read_text())
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("rows"), list):
        return value["rows"]
    raise ValueError(f"unsupported row container in {path}")


def expected(row: Mapping[str, Any]) -> dict[str, Any]:
    nested = row.get("expected") if isinstance(row.get("expected"), dict) else {}
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    raw_context = row.get("context")

    route = first_present(row, ("route",), _MISSING)
    if route is _MISSING:
        route = first_present(nested, ("route",), None)

    authority = first_present(row, ("authority",), _MISSING)
    if authority is _MISSING:
        authority = first_present(nested, ("authority",), "allow")

    if isinstance(raw_context, str):
        context = raw_context
    else:
        context = first_present(row, ("context_state",), _MISSING)
        if context is _MISSING:
            context = first_present(nested, ("context", "context_state"), "ready")

    outcomes = first_present(row, ("ordered_outcomes", "outcomes"), _MISSING)
    if outcomes is _MISSING:
        outcomes = first_present(nested, ("ordered_outcomes", "outcomes"), [])

    family = first_present(row, ("failure_family",), _MISSING)
    if family is _MISSING:
        family = first_present(metadata, ("failure_family",), None)

    return {
        "route": route,
        "authority": authority,
        "context": context,
        "failure_family": family,
        "outcomes": outcomes,
    }


def source_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
    labels = expected(row)
    prompt = user_text(row)
    outcomes = labels["outcomes"]
    if (
        not prompt
        or labels["route"] not in ROUTES
        or labels["authority"] not in AUTH
        or labels["context"] not in CONTEXT
        or labels["failure_family"] not in FAILURES
        or not isinstance(outcomes, list)
        or len(outcomes) > 6
        or any(not isinstance(item, str) or not item.strip() or len(item.strip()) > 200 for item in outcomes)
    ):
        return None

    context_value = row.get("context") if isinstance(row.get("context"), dict) else {}
    attachments = first_present(row, ("attachments", "files", "attached_files"), _MISSING)
    if attachments is _MISSING:
        attachments = []
    memory = first_present(row, ("memory", "memories"), _MISSING)
    if memory is _MISSING:
        memory = first_present(context_value, ("memory",), "")
    thread = first_present(row, ("thread", "reply_to"), _MISSING)
    if thread is _MISSING:
        thread = first_present(context_value, ("thread",), "")

    normalized = {**row, **labels, "prompt": prompt}
    normalized["context_state"] = labels["context"]
    normalized["attachments"] = attachments
    normalized["memory"] = memory
    normalized["thread"] = thread
    return normalized


def frozen(paths: list[str]) -> list[str]:
    missing = [path for path in paths if not Path(path).is_file()]
    if missing:
        raise FileNotFoundError(f"missing frozen evaluation files: {missing}")
    return sorted(
        set(canon(user_text(row)) for path in paths for row in load(path) if user_text(row))
    )


def jaccard(first: Any, second: Any) -> float:
    left, right = set(canon(first).split()), set(canon(second).split())
    return len(left & right) / max(1, len(left | right))


def near_any(text: Any, candidates: list[str] | set[str], threshold: float) -> bool:
    return threshold > 0 and any(jaccard(text, candidate) >= threshold for candidate in candidates)


def endpoint(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"


def trim_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[:limit] + "…"


def attachment_projection(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:4]:
        if isinstance(item, str):
            result.append({"name": trim_text(item, 160), "type": ""})
        elif isinstance(item, dict):
            result.append(
                {
                    "name": trim_text(item.get("name") or item.get("filename") or "", 160),
                    "type": trim_text(item.get("type") or item.get("mime_type") or "", 80),
                }
            )
    return result


def memory_projection(value: Any) -> list[str] | str:
    if isinstance(value, list):
        return [trim_text(item, 240) for item in value[:3]]
    return trim_text(value, 720)


def context_projection(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "attachments": attachment_projection(row.get("attachments")),
        "memory": memory_projection(row.get("memory")),
        "thread": trim_text(row.get("thread"), 720),
    }


def source_identity(row: Mapping[str, Any]) -> dict[str, Any]:
    labels = expected(row)
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    provenance = {}
    for key in ("source_group", "origin_id", "template_id", "cluster_id", "source_id"):
        value = first_present(row, (key,), _MISSING)
        if value is _MISSING:
            value = first_present(metadata, (key,), _MISSING)
        if value is not _MISSING:
            provenance[key] = value
    return {
        "declared_id": row.get("id"),
        "declared_source_digest": row.get("source_digest"),
        "prompt": canon(user_text(row)),
        "route": labels["route"],
        "authority": labels["authority"],
        "context": labels["context"],
        "failure_family": labels["failure_family"],
        "ordered_outcomes": labels["outcomes"],
        "transform_type": row.get("transform_type"),
        "structural_context": context_projection(row),
        "provenance": provenance,
    }


def source_digest(row: Mapping[str, Any]) -> str:
    return digest(source_identity(row))


def object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def generation_schema(batch_size: int, samples: int) -> dict[str, Any]:
    candidate = object_schema(
        {
            "source_id": {"type": "integer", "minimum": 0, "maximum": max(0, batch_size - 1)},
            "prompt": {"type": "string", "minLength": 1, "maxLength": 1200},
            "route": {"type": "string", "enum": ROUTES},
            "authority": {"type": "string", "enum": AUTH},
            "context": {"type": "string", "enum": CONTEXT},
            "active_clauses": {"type": "integer", "minimum": 0, "maximum": 6},
            "compound": {"type": "boolean"},
            "operation": {"type": "string", "minLength": 1, "maxLength": 160},
            "target": {"type": "string", "minLength": 1, "maxLength": 240},
            "ordered_outcomes": {
                "type": "array",
                "maxItems": 6,
                "items": {"type": "string", "minLength": 1, "maxLength": 200},
            },
            "failure_family": {"type": "string", "enum": FAILURES},
        },
        [
            "source_id", "prompt", "route", "authority", "context", "active_clauses",
            "compound", "operation", "target", "ordered_outcomes", "failure_family",
        ],
    )
    return object_schema(
        {
            "candidates": {
                "type": "array",
                "minItems": 0,
                "maxItems": batch_size * samples,
                "items": candidate,
            }
        },
        ["candidates"],
    )


def verifier_schema(candidate_ids: list[str]) -> dict[str, Any]:
    verdict = object_schema(
        {
            "candidate_id": {"type": "string", "enum": candidate_ids},
            "route": {"type": "string", "enum": ROUTES},
            "authority": {"type": "string", "enum": AUTH},
            "context": {"type": "string", "enum": CONTEXT},
            "active_clauses": {"type": "integer", "minimum": 0, "maximum": 6},
            "compound": {"type": "boolean"},
            "faithful": {"type": "boolean"},
            "authority_preserved": {"type": "boolean"},
            "context_preserved": {"type": "boolean"},
            "ordered_outcomes_preserved": {"type": "boolean"},
            "negation_preserved": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        [
            "candidate_id", "route", "authority", "context", "active_clauses", "compound",
            "faithful", "authority_preserved", "context_preserved",
            "ordered_outcomes_preserved", "negation_preserved", "confidence",
        ],
    )
    return object_schema(
        {
            "verdicts": {
                "type": "array",
                "minItems": len(candidate_ids),
                "maxItems": len(candidate_ids),
                "items": verdict,
            }
        },
        ["verdicts"],
    )


def response_format(mode: str, name: str, schema: dict[str, Any]) -> dict[str, Any]:
    if mode == "json_schema":
        return {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
    return {"type": "json_object"}
