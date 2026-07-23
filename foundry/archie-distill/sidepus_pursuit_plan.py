#!/usr/bin/env python3
"""Seal Sidepus experience intent without downloading every payload."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import tempfile
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
EXPERIENCE_SCHEMA = "sidepus-experience-metadata/v1"
INTENT_SCHEMA = "sidepus-pursuit-intent-plan/v2"
INTENT_ROW_SCHEMA = "sidepus-pursuit-intent-row/v2"
INTENT_RECEIPT_SCHEMA = "sidepus-pursuit-intent-receipt/v2"
ARCHIVE_CHANNELS = (
    "production_context", "observation", "utterance", "interpretation",
    "action_consequence", "evaluation_only",
)
MODEL_VISIBLE_CHANNELS = (
    "production_context", "observation", "utterance", "action_consequence",
)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode()).hexdigest()


def sha256_file(path: pathlib.Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: pathlib.Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(dict(value), indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.expanduser().resolve().open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number} is not an object")
            rows.append(value)
    return rows


def deterministic_unit(seed: int, *parts: Any) -> float:
    material = "\x1f".join(map(str, (seed, *parts))).encode()
    return int(hashlib.sha256(material).hexdigest()[:16], 16) / float(0xFFFFFFFFFFFFFFFF)


def authorized(record: Mapping[str, Any]) -> bool:
    rights = record.get("rights") if isinstance(record.get("rights"), Mapping) else {}
    flags = set(map(str, record.get("flags", [])))
    return rights.get("allow_training") is True and "rights-blocked" not in flags


def effective_object_ref(item: Mapping[str, Any]) -> dict[str, Any]:
    """Use the exact object consumed by training, not merely its archival parent."""
    training_view = item.get("training_view")
    if isinstance(training_view, Mapping):
        if not training_view.get("sha256"):
            raise ValueError("training_view requires a SHA-256 object reference")
        return {
            **dict(training_view),
            "source_object_sha256": str(item.get("sha256", "")),
            "view_role": "training_view",
        }
    if not item.get("sha256"):
        raise ValueError("channel object requires sha256")
    return dict(item)


def object_refs(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    objects = record.get("channel_objects")
    if not isinstance(objects, Mapping):
        raise ValueError("record has no channel_objects")
    refs: list[dict[str, Any]] = []
    for channel in MODEL_VISIBLE_CHANNELS:
        items = objects.get(channel, [])
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, Mapping):
                refs.append({"channel": channel, **effective_object_ref(item)})
    return refs


def experience_vector(record: Mapping[str, Any]) -> dict[str, float]:
    metadata = record.get("experience_metadata")
    if not isinstance(metadata, Mapping) or metadata.get("schema") != EXPERIENCE_SCHEMA:
        return {}
    vector = metadata.get("curriculum_vector")
    if not isinstance(vector, Mapping):
        return {}
    return {str(k): max(0.0, min(1.0, float(v))) for k, v in vector.items()}


def difficulty(record: Mapping[str, Any]) -> float:
    metadata = record.get("experience_metadata")
    claim = metadata.get("difficulty_prior") if isinstance(metadata, Mapping) else None
    if not isinstance(claim, Mapping):
        return 0.25
    return max(0.0, min(1.0, float(claim.get("value") or 0.0)))


def sequence_identity(record: Mapping[str, Any]) -> str | None:
    value = record.get("sequence_id") or record.get("episode_id") or record.get("thread_id")
    text = str(value).strip() if value is not None else ""
    return text or None


def sequence_index(record: Mapping[str, Any]) -> int | None:
    value = record.get("sequence_index")
    if value is None:
        value = record.get("episode_index")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def build_intent_plan(
    *, inventory: pathlib.Path, output: pathlib.Path, samples: int, sequence_length: int,
    seed: int, minimum_quality: float, required_channels: Sequence[str],
    excluded_flags: Sequence[str], domain_targets: Mapping[str, float] | None,
    sequence_follow_probability: float = 0.7,
) -> dict[str, Any]:
    if samples < 1 or sequence_length < 8:
        raise ValueError("samples and sequence_length must be positive")
    if not 0.0 <= sequence_follow_probability <= 1.0:
        raise ValueError("sequence_follow_probability must be in [0,1]")
    required, excluded = set(required_channels), set(excluded_flags)
    records: list[dict[str, Any]] = []
    counts = Counter()
    for record in read_jsonl(inventory):
        counts["inventory"] += 1
        if record.get("schema") != INVENTORY_SCHEMA or not authorized(record):
            counts["authority_rejected"] += 1
            continue
        if float(record.get("quality_score", 0.0)) < minimum_quality:
            counts["quality_rejected"] += 1
            continue
        channels = set(map(str, record.get("channels", [])))
        flags = set(map(str, record.get("flags", [])))
        if not required.issubset(channels) or excluded & flags:
            counts["selector_rejected"] += 1
            continue
        object_refs(record)
        records.append(record)
        counts["eligible"] += 1
    if not records:
        raise ValueError("no pursuit-eligible records")
    records.sort(key=lambda row: str(row.get("record_id")))

    by_domain: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sequences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        by_domain[str(record.get("domain", "unknown"))].append(record)
        identity = sequence_identity(record)
        if identity is not None and sequence_index(record) is not None:
            sequences[identity].append(record)
    next_record: dict[str, dict[str, Any]] = {}
    for identity, members in sequences.items():
        ordered = sorted(members, key=lambda row: (int(sequence_index(row) or 0), str(row.get("record_id"))))
        for current, following in zip(ordered, ordered[1:]):
            next_record[str(current["record_id"])] = following
        counts["explicit_sequences"] += 1
        counts["sequenced_records"] += len(ordered)

    weights = (
        {domain: max(0.0, float(domain_targets.get(domain, 0.0))) for domain in by_domain}
        if domain_targets else {domain: float(len(bucket)) for domain, bucket in by_domain.items()}
    )
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("domain target weights sum to zero")
    normalized = {domain: value / total for domain, value in sorted(weights.items()) if value > 0}

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    hasher, domain_counts = hashlib.sha256(), Counter()
    previous_record: dict[str, Any] | None = None
    followed = 0
    with tempfile.NamedTemporaryFile(dir=output.parent, mode="w", encoding="utf-8", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            domains = list(normalized)
            for sample_index in range(samples):
                candidate_follow = (
                    next_record.get(str(previous_record.get("record_id")))
                    if previous_record is not None else None
                )
                should_follow = (
                    candidate_follow is not None
                    and deterministic_unit(seed, "sequence-follow", sample_index) < sequence_follow_probability
                )
                if should_follow:
                    record = candidate_follow
                    domain = str(record.get("domain", "unknown"))
                    followed += 1
                else:
                    point = deterministic_unit(seed, "domain", sample_index)
                    accumulated, domain = 0.0, domains[-1]
                    for candidate in domains:
                        accumulated += normalized[candidate]
                        if point < accumulated:
                            domain = candidate
                            break
                    bucket = by_domain[domain]
                    index = int(deterministic_unit(seed, "record", sample_index) * len(bucket)) % len(bucket)
                    record = bucket[index]
                intent_id = f"intent_{digest_json([seed, sample_index, record['record_id']])[:32]}"
                explicit_thread = sequence_identity(record)
                row = {
                    "schema": INTENT_ROW_SCHEMA,
                    "sample_index": sample_index,
                    "intent_id": intent_id,
                    "record_id": str(record["record_id"]),
                    "primary_domain": domain,
                    "state_thread_id": explicit_thread or intent_id,
                    "sequence_index": sequence_index(record),
                    "has_explicit_sequence": explicit_thread is not None,
                    "window_seed": int(deterministic_unit(seed, "window", sample_index) * (2**63 - 1)),
                    "window_tokens": sequence_length + 1,
                    "render_mode": "multichannel",
                    "difficulty_prior": difficulty(record),
                    "curriculum_vector": experience_vector(record),
                    "object_refs": object_refs(record),
                }
                encoded = stable_json(row)
                handle.write(encoded + "\n")
                hasher.update((encoded + "\n").encode())
                domain_counts[domain] += 1
                previous_record = record
            handle.flush(); os.fsync(handle.fileno()); os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    receipt = {
        "schema": INTENT_RECEIPT_SCHEMA, "plan_schema": INTENT_SCHEMA,
        "inventory": str(inventory.expanduser().resolve()),
        "inventory_sha256": sha256_file(inventory.expanduser().resolve()),
        "plan": str(output), "plan_sha256": sha256_file(output), "plan_digest": hasher.hexdigest(),
        "samples": samples, "sequence_length": sequence_length, "seed": seed,
        "minimum_quality": minimum_quality, "required_channels": list(required_channels),
        "excluded_flags": list(excluded_flags), "domain_targets": normalized,
        "realized_domains": dict(sorted(domain_counts.items())),
        "selection_counts": dict(sorted(counts.items())),
        "sequence_follow_probability": sequence_follow_probability,
        "realized_sequence_follows": followed,
        "model_visible_channels": list(MODEL_VISIBLE_CHANNELS),
        "hidden_archive_channels": sorted(set(ARCHIVE_CHANNELS) - set(MODEL_VISIBLE_CHANNELS)),
        "two_phase_sealing": True,
        "claim_boundary": (
            "Intent seals explicit experience threads and effective training-view object digests without requiring all payloads locally. "
            "Unsequenced records receive one-intent state threads, compiler interpretation remains hidden, and exact windows are sealed on first materialization."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(output.with_suffix(output.suffix + ".receipt.json"), receipt)
    return receipt
