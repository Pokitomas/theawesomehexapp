#!/usr/bin/env python3
"""Compile Sidepus records into uncertainty-bearing experience metadata.

The compiler never upgrades an inference into an observation. Every derived field carries
method, evidence, confidence, and alternatives so curriculum code can use weak labels
without confusing them for truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any

SOURCE_SCHEMA = "sidepus-developmental-inventory-record/v1"
EXPERIENCE_SCHEMA = "sidepus-experience-metadata/v1"
RECEIPT_SCHEMA = "sidepus-experience-compilation-receipt/v1"
CLAIM_SCHEMA = "sidepus-uncertain-claim/v1"
COMPILER_ID = "sidepus-experience-compiler/feral-v1"


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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
        tmp = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def claim(
    value: Any,
    confidence: float,
    *,
    evidence: Iterable[str],
    method: str,
    alternatives: Iterable[Any] = (),
    abstained: bool = False,
) -> dict[str, Any]:
    return {
        "schema": CLAIM_SCHEMA,
        "value": None if abstained else value,
        "confidence": 0.0 if abstained else clamp(confidence),
        "evidence": sorted(set(map(str, evidence))),
        "method": method,
        "alternatives": list(alternatives),
        "status": "abstained" if abstained else "compiler-hypothesis",
    }


def score_claim(value: float, confidence: float, evidence: Iterable[str], method: str) -> dict[str, Any]:
    return claim(round(clamp(value), 6), confidence, evidence=evidence, method=method)


def _mime_family(record: Mapping[str, Any]) -> str:
    medium = str(record.get("medium", "unknown")).lower()
    if medium in {"image", "audio", "video", "text", "application", "model"}:
        return medium
    objects = record.get("channel_objects") if isinstance(record.get("channel_objects"), dict) else {}
    for items in objects.values():
        if not isinstance(items, list):
            continue
        for item in items:
            mime = str(item.get("media_type", "")).split("/", 1)[0].lower()
            if mime:
                return mime
    return medium or "unknown"


def _signals(record: Mapping[str, Any]) -> list[str]:
    channels = set(map(str, record.get("channels", [])))
    flags = set(map(str, record.get("flags", [])))
    domain = str(record.get("domain", "unknown"))
    medium = _mime_family(record)
    signals = {f"domain:{domain}", f"medium:{medium}"}
    signals.update(f"channel:{channel}" for channel in channels)
    signals.update(f"flag:{flag}" for flag in flags)
    return sorted(signals)


def compile_experience(record: Mapping[str, Any]) -> dict[str, Any]:
    if record.get("schema") != SOURCE_SCHEMA:
        raise ValueError(f"record must use {SOURCE_SCHEMA}")
    record_id = str(record.get("record_id", "")).strip()
    if not record_id:
        raise ValueError("record_id is required")

    evidence = _signals(record)
    medium = _mime_family(record)
    channels = set(map(str, record.get("channels", [])))
    flags = set(map(str, record.get("flags", [])))
    domain = str(record.get("domain", "unknown"))
    quality = clamp(float(record.get("quality_score", 0.0)))

    temporal = medium in {"audio", "video"} or "action_consequence" in channels
    sensory = medium in {"image", "audio", "video", "model"}
    executable = domain == "formal_executable" or "action_consequence" in channels
    social = domain == "social_institutional"
    expressive = domain == "language_expression" or "utterance" in channels
    empirical = domain == "empirical_world"
    contaminated = domain == "adversarial_messy" or bool(
        flags & {"duplicate", "persuasive", "spam", "contradictory", "low-integrity"}
    )

    primitive_scores = {
        "persistence": 0.25 + 0.45 * temporal + 0.15 * empirical,
        "identity_tracking": 0.20 + 0.50 * temporal + 0.15 * social,
        "geometry": 0.10 + 0.65 * (medium in {"image", "video", "model"}),
        "dynamics": 0.10 + 0.70 * temporal + 0.10 * empirical,
        "intervention": 0.05 + 0.75 * ("action_consequence" in channels) + 0.10 * executable,
        "causal_direction": 0.10 + 0.55 * ("action_consequence" in channels) + 0.15 * temporal,
        "agency": 0.10 + 0.35 * social + 0.30 * temporal + 0.15 * executable,
        "communication": 0.10 + 0.70 * expressive + 0.10 * social,
        "social_modeling": 0.05 + 0.70 * social + 0.15 * expressive,
        "formal_composition": 0.10 + 0.75 * executable,
        "debugging": 0.05 + 0.60 * executable + 0.20 * ("action_consequence" in channels),
        "source_separation": 0.15 + 0.45 * ("production_context" in channels) + 0.20 * expressive,
        "uncertainty_reasoning": 0.10 + 0.45 * contaminated + 0.20 * ("interpretation" in channels),
        "compression": 0.25 + 0.25 * expressive + 0.20 * executable + 0.15 * sensory,
        "cross_modal_binding": 0.05 + 0.70 * (sensory and expressive),
    }
    primitive_scores = {key: clamp(value) for key, value in primitive_scores.items()}

    confidence = clamp(0.25 + 0.55 * quality + 0.05 * min(len(channels), 4))
    temporal_kind = (
        "ordered-sensory-stream" if medium in {"audio", "video"}
        else "state-transition-record" if "action_consequence" in channels
        else "static-artifact"
    )
    clock = {
        "kind": claim(
            temporal_kind,
            confidence if temporal else max(0.35, confidence - 0.2),
            evidence=evidence,
            method="channel-and-medium-affordance",
            alternatives=["unordered-collection", "unknown-order"],
        ),
        "ordered": claim(
            temporal,
            confidence,
            evidence=evidence,
            method="medium-or-consequence-presence",
            alternatives=[not temporal],
        ),
        "native_timestamp_available": claim(
            bool(record.get("timestamp") or record.get("warc_date")),
            0.95,
            evidence=["record timestamp fields"],
            method="direct-field-presence",
        ),
    }

    hazards = {
        "label_leakage": score_claim(
            0.75 if "interpretation" in channels else 0.15,
            0.9,
            ["channel:interpretation"] if "interpretation" in channels else ["interpretation absent"],
            "channel-boundary-risk",
        ),
        "narrative_persuasion": score_claim(
            0.65 if expressive or contaminated else 0.15,
            confidence,
            evidence,
            "domain-medium-risk",
        ),
        "production_artifact_shortcut": score_claim(
            0.60 if "production_context" in channels else 0.10,
            confidence,
            evidence,
            "production-context-presence",
        ),
        "temporal_aliasing": score_claim(
            0.55 if temporal and not (record.get("timestamp") or record.get("warc_date")) else 0.15,
            confidence,
            evidence,
            "temporal-without-clock-risk",
        ),
        "rights_uncertainty": score_claim(
            0.95 if "rights-blocked" in flags else 0.05,
            0.99,
            evidence,
            "rights-flag-presence",
        ),
    }

    curriculum_vector = {
        name: round(value * (0.5 + 0.5 * quality), 6)
        for name, value in primitive_scores.items()
    }
    difficulty_prior = clamp(
        0.15
        + 0.25 * temporal
        + 0.20 * sensory
        + 0.15 * contaminated
        + 0.15 * ("action_consequence" in channels)
        + 0.10 * (1.0 - quality)
    )

    return {
        "schema": EXPERIENCE_SCHEMA,
        "compiler": COMPILER_ID,
        "record_id": record_id,
        "source_record_sha256": hashlib.sha256(stable_json(dict(record)).encode()).hexdigest(),
        "epistemic_boundary": (
            "All fields below are curriculum hypotheses derived from archive metadata. "
            "They are never observations, truth labels, or ordinary model-visible context unless a program explicitly exposes them."
        ),
        "clock": clock,
        "primitive_affordances": {
            name: score_claim(value, confidence, evidence, "deterministic-affordance-heuristic")
            for name, value in sorted(primitive_scores.items())
        },
        "curriculum_vector": curriculum_vector,
        "difficulty_prior": score_claim(difficulty_prior, confidence, evidence, "affordance-composition"),
        "hazards": hazards,
        "modality": claim(
            medium,
            0.95 if medium != "unknown" else 0.0,
            evidence=[f"medium:{medium}"],
            method="inventory-medium",
            abstained=medium == "unknown",
        ),
        "sequence_identity": claim(
            record.get("episode_id") or record.get("sequence_id"),
            0.98 if record.get("episode_id") or record.get("sequence_id") else 0.0,
            evidence=["explicit episode_id/sequence_id"] if record.get("episode_id") or record.get("sequence_id") else [],
            method="explicit-field-only",
            abstained=not bool(record.get("episode_id") or record.get("sequence_id")),
        ),
        "needs_adapter": claim(
            sensory,
            0.98,
            evidence=[f"medium:{medium}"],
            method="nontext-modality-requires-feature-adapter",
        ),
    }


def compile_inventory(source: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    source = source.expanduser().resolve()
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    counts = Counter()
    with source.open("r", encoding="utf-8") as input_handle, tempfile.NamedTemporaryFile(
        dir=output.parent, mode="w", encoding="utf-8", delete=False
    ) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            for line_number, line in enumerate(input_handle, 1):
                if not line.strip():
                    continue
                raw = json.loads(line)
                if not isinstance(raw, dict):
                    raise ValueError(f"{source}:{line_number} is not an object")
                enriched = dict(raw)
                metadata = compile_experience(raw)
                enriched["experience_metadata"] = metadata
                encoded = stable_json(enriched)
                handle.write(encoded + "\n")
                hasher.update((encoded + "\n").encode())
                counts["records"] += 1
                modality = metadata["modality"].get("value") or "unknown"
                counts[f"modality:{modality}"] += 1
                if metadata["needs_adapter"]["value"]:
                    counts["needs_adapter"] += 1
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    if not counts["records"]:
        raise ValueError("experience inventory is empty")
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "compiler": COMPILER_ID,
        "source": str(source),
        "source_sha256": sha256_file(source),
        "output": str(output),
        "output_sha256": sha256_file(output),
        "output_digest": hasher.hexdigest(),
        "counts": dict(sorted(counts.items())),
        "claim_boundary": (
            "Compilation adds uncertain curriculum metadata while preserving source records. "
            "It does not establish semantic truth, developmental optimality, or modality understanding."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    atomic_json(output.with_suffix(output.suffix + ".receipt.json"), receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(compile_inventory(pathlib.Path(args.inventory), pathlib.Path(args.output)), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
