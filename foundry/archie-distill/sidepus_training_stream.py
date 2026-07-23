#!/usr/bin/env python3
"""Deterministic direct-from-Sidepus training plans and prefetch samplers.

The plan stores only immutable object references and replay metadata. Token bytes are
read from the Sidepus content-addressed object store on demand, so the archive is not
flattened into a second monolithic corpus.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import pathlib
import random
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import torch

from archie_hybrid_core import BOS_ID, EOS_ID, PAD_ID, SEP_ID, ByteTokenizer

INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
PLAN_SCHEMA = "sidepus-direct-training-plan/v1"
PLAN_ROW_SCHEMA = "sidepus-direct-training-plan-row/v1"
PLAN_RECEIPT_SCHEMA = "sidepus-direct-training-plan-receipt/v1"
RENDERER_SCHEMA = "sidepus-direct-episode-renderer/v1"
TEXT_MEDIA_PREFIXES = ("text/",)
TEXT_MEDIA_TYPES = {
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
}
TRAINING_CHANNELS = (
    "production_context",
    "observation",
    "utterance",
    "interpretation",
    "action_consequence",
)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk_size):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} is not a JSON object")
            rows.append(value)
    return rows


class ObjectStore:
    """Read immutable Sidepus objects by SHA-256 and verify bytes on first access."""

    def __init__(self, state_dir: pathlib.Path, *, verify: bool = True) -> None:
        self.state_dir = state_dir.expanduser().resolve()
        self.root = self.state_dir / "objects" / "sha256"
        self.verify = verify
        self._verified: set[str] = set()

    @staticmethod
    def validate_digest(digest: str) -> str:
        value = str(digest).lower()
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError(f"invalid SHA-256 digest: {digest!r}")
        return value

    def path(self, digest: str) -> pathlib.Path:
        value = self.validate_digest(digest)
        return self.root / value[:2] / value[2:]

    def read(self, digest: str) -> bytes:
        value = self.validate_digest(digest)
        path = self.path(value)
        payload = path.read_bytes()
        if self.verify and value not in self._verified:
            actual = hashlib.sha256(payload).hexdigest()
            if actual != value:
                raise RuntimeError(f"Sidepus object digest mismatch: {value} != {actual}")
            self._verified.add(value)
        return payload


@dataclass(frozen=True)
class Record:
    record_id: str
    domain: str
    language: str
    era: str
    quality_score: float
    channels: tuple[str, ...]
    channel_objects: dict[str, list[dict[str, Any]]]
    source_host: str | None
    flags: tuple[str, ...]

    @classmethod
    def from_inventory(cls, raw: Mapping[str, Any]) -> "Record":
        if raw.get("schema") != INVENTORY_SCHEMA:
            raise ValueError(f"inventory row must use {INVENTORY_SCHEMA}")
        rights = raw.get("rights") if isinstance(raw.get("rights"), dict) else {}
        if rights.get("allow_training") is not True:
            raise ValueError("record is not training-authorized")
        flags = tuple(sorted(set(map(str, raw.get("flags", [])))))
        if "rights-blocked" in flags:
            raise ValueError("record is rights-blocked")
        objects = raw.get("channel_objects")
        if not isinstance(objects, dict):
            raise ValueError("record has no channel_objects")
        channels = tuple(sorted(set(map(str, raw.get("channels", [])))))
        return cls(
            record_id=str(raw.get("record_id", "")),
            domain=str(raw.get("domain", "unknown")),
            language=str(raw.get("language", "und")),
            era=str(raw.get("era", "unknown")),
            quality_score=float(raw.get("quality_score", 0.0)),
            channels=channels,
            channel_objects={str(k): [dict(x) for x in v] for k, v in objects.items()},
            source_host=str(raw.get("source_host")) if raw.get("source_host") else None,
            flags=flags,
        )


class EpisodeRenderer:
    """Render channel-preserving or matched-control training episodes."""

    def __init__(self, store: ObjectStore, mode: str = "multichannel") -> None:
        if mode not in {"multichannel", "utterance-only", "flattened-control", "structure-only"}:
            raise ValueError(f"unsupported render mode: {mode}")
        self.store = store
        self.mode = mode
        self._cache: dict[str, tuple[list[int], str]] = {}

    @staticmethod
    def _is_text(media_type: str) -> bool:
        mime = media_type.split(";", 1)[0].strip().lower()
        return mime.startswith(TEXT_MEDIA_PREFIXES) or mime in TEXT_MEDIA_TYPES

    def _object_text(self, item: Mapping[str, Any]) -> str:
        digest = str(item.get("sha256", ""))
        media_type = str(item.get("media_type", "application/octet-stream"))
        payload = self.store.read(digest)
        if self._is_text(media_type):
            return payload.decode("utf-8", errors="replace").strip()
        descriptor = {
            "sha256": digest,
            "media_type": media_type,
            "bytes": int(item.get("bytes", len(payload))),
            "representation": "content-addressed-nontext-observation",
        }
        return stable_json(descriptor)

    def _channel(self, record: Record, channel: str) -> str:
        items = record.channel_objects.get(channel, [])
        return "\n".join(self._object_text(item) for item in items).strip()

    def render(self, record: Record) -> tuple[list[int], str]:
        cache_key = f"{self.mode}:{record.record_id}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        values = {channel: self._channel(record, channel) for channel in TRAINING_CHANNELS}
        if self.mode == "utterance-only":
            text = values["utterance"]
        elif self.mode == "flattened-control":
            text = "\n".join(values[channel] for channel in TRAINING_CHANNELS if values[channel])
        elif self.mode == "structure-only":
            text = stable_json({
                "schema": RENDERER_SCHEMA,
                "record_id": record.record_id,
                "domain": record.domain,
                "language": record.language,
                "era": record.era,
                "channels": [channel for channel in TRAINING_CHANNELS if values[channel]],
                "object_sha256": {
                    channel: [str(item.get("sha256")) for item in record.channel_objects.get(channel, [])]
                    for channel in TRAINING_CHANNELS
                    if record.channel_objects.get(channel)
                },
            })
        else:
            parts = [
                '<sidepus:episode schema="sidepus-direct-episode/v1">',
                f"<record_id>{record.record_id}</record_id>",
                f"<domain>{record.domain}</domain>",
                f"<language>{record.language}</language>",
                f"<era>{record.era}</era>",
            ]
            for channel in TRAINING_CHANNELS:
                value = values[channel]
                if value:
                    parts.extend((f"<{channel}>", value, f"</{channel}>"))
            parts.append("</sidepus:episode>")
            text = "\n".join(parts)

        tokens = [BOS_ID, *ByteTokenizer.encode(text), EOS_ID, SEP_ID]
        digest = hashlib.sha256(
            b"".join(int(token).to_bytes(2, "little") for token in tokens)
        ).hexdigest()
        result = (tokens, digest)
        self._cache[cache_key] = result
        return result


def eligible_records(
    inventory: pathlib.Path,
    *,
    minimum_quality: float,
    required_channels: Sequence[str],
    excluded_flags: Sequence[str],
) -> tuple[list[Record], dict[str, int]]:
    retained: list[Record] = []
    counts = Counter()
    required = set(required_channels)
    blocked = set(excluded_flags)
    for raw in read_jsonl(inventory):
        counts["inventory_rows"] += 1
        try:
            record = Record.from_inventory(raw)
        except ValueError:
            counts["rights_or_schema_rejected"] += 1
            continue
        if record.quality_score < minimum_quality:
            counts["quality_rejected"] += 1
            continue
        if not required.issubset(record.channels):
            counts["channel_rejected"] += 1
            continue
        if blocked.intersection(record.flags):
            counts["flag_rejected"] += 1
            continue
        retained.append(record)
        counts["eligible"] += 1
    if not retained:
        raise ValueError("no training-eligible Sidepus records")
    retained.sort(key=lambda item: item.record_id)
    return retained, dict(sorted(counts.items()))


def normalized_targets(records: Sequence[Record], targets: Mapping[str, float] | None) -> dict[str, float]:
    domains = sorted({record.domain for record in records})
    if targets:
        values = {domain: max(float(targets.get(domain, 0.0)), 0.0) for domain in domains}
    else:
        counts = Counter(record.domain for record in records)
        values = {domain: float(counts[domain]) for domain in domains}
    total = sum(values.values())
    if total <= 0:
        raise ValueError("domain target weights sum to zero")
    return {domain: values[domain] / total for domain in domains if values[domain] > 0}


def choose_weighted(weights: Mapping[str, float], value: float) -> str:
    cumulative = 0.0
    last = next(iter(weights))
    for key, weight in weights.items():
        cumulative += weight
        last = key
        if value < cumulative:
            return key
    return last


def deterministic_unit(seed: int, *parts: Any) -> float:
    material = "\x1f".join(map(str, (seed, *parts))).encode()
    integer = int(hashlib.sha256(material).hexdigest()[:16], 16)
    return integer / float(0xFFFFFFFFFFFFFFFF)


def build_plan(
    *,
    state_dir: pathlib.Path,
    inventory: pathlib.Path,
    output: pathlib.Path,
    samples: int,
    sequence_length: int,
    seed: int,
    render_mode: str,
    minimum_quality: float,
    required_channels: Sequence[str],
    excluded_flags: Sequence[str],
    domain_targets: Mapping[str, float] | None,
) -> dict[str, Any]:
    if samples < 1 or sequence_length < 8:
        raise ValueError("samples and sequence_length must be positive")
    records, selection_counts = eligible_records(
        inventory,
        minimum_quality=minimum_quality,
        required_channels=required_channels,
        excluded_flags=excluded_flags,
    )
    by_id = {record.record_id: record for record in records}
    buckets: dict[str, list[Record]] = defaultdict(list)
    for record in records:
        buckets[record.domain].append(record)
    targets = normalized_targets(records, domain_targets)
    store = ObjectStore(state_dir)
    renderer = EpisodeRenderer(store, render_mode)
    target_tokens = sequence_length + 1
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    inventory_sha = sha256_file(inventory)
    plan_hasher = hashlib.sha256()
    domain_counts = Counter()
    object_digests: set[str] = set()
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False, mode="w", encoding="utf-8") as handle:
        temporary = pathlib.Path(handle.name)
        try:
            for sample_index in range(samples):
                chosen_domain = choose_weighted(targets, deterministic_unit(seed, "domain", sample_index))
                bucket = buckets[chosen_domain]
                first_index = int(deterministic_unit(seed, "record", sample_index) * len(bucket)) % len(bucket)
                fragments: list[dict[str, Any]] = []
                stream: list[int] = []
                visit = 0
                while len(stream) < target_tokens:
                    if visit == 0:
                        record = bucket[first_index]
                    else:
                        follow_index = int(
                            deterministic_unit(seed, "follow", sample_index, visit) * len(records)
                        ) % len(records)
                        record = records[follow_index]
                    tokens, episode_digest = renderer.render(record)
                    fragments.append({
                        "record_id": record.record_id,
                        "episode_sha256": episode_digest,
                        "token_count": len(tokens),
                    })
                    for channel_items in record.channel_objects.values():
                        for item in channel_items:
                            digest = str(item.get("sha256", ""))
                            if digest:
                                object_digests.add(digest)
                    stream.extend(tokens)
                    visit += 1
                    if visit > 128:
                        raise RuntimeError("unable to assemble a complete Sidepus sample")
                maximum = len(stream) - target_tokens
                start = int(deterministic_unit(seed, "window", sample_index) * (maximum + 1)) if maximum else 0
                window = stream[start:start + target_tokens]
                window_bytes = b"".join(int(token).to_bytes(2, "little") for token in window)
                row = {
                    "schema": PLAN_ROW_SCHEMA,
                    "sample_index": sample_index,
                    "render_mode": render_mode,
                    "fragments": fragments,
                    "window_start": start,
                    "window_tokens": target_tokens,
                    "window_sha256": hashlib.sha256(window_bytes).hexdigest(),
                    "primary_domain": chosen_domain,
                }
                encoded = stable_json(row)
                handle.write(encoded + "\n")
                plan_hasher.update((encoded + "\n").encode())
                domain_counts[chosen_domain] += 1
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    receipt = {
        "schema": PLAN_RECEIPT_SCHEMA,
        "plan_schema": PLAN_SCHEMA,
        "renderer_schema": RENDERER_SCHEMA,
        "state_dir": str(state_dir.expanduser().resolve()),
        "inventory": str(inventory.expanduser().resolve()),
        "inventory_sha256": inventory_sha,
        "plan": str(output),
        "plan_sha256": sha256_file(output),
        "plan_digest": plan_hasher.hexdigest(),
        "samples": samples,
        "sequence_length": sequence_length,
        "seed": seed,
        "render_mode": render_mode,
        "minimum_quality": minimum_quality,
        "required_channels": list(required_channels),
        "excluded_flags": list(excluded_flags),
        "domain_targets": targets,
        "realized_domains": dict(sorted(domain_counts.items())),
        "selection_counts": selection_counts,
        "referenced_objects": len(object_digests),
        "tokenizer": ByteTokenizer.metadata(),
        "claim_boundary": (
            "The plan binds immutable Sidepus objects and exact replay windows. It does not "
            "copy archive payloads into a corpus, prove content quality, or authorize model promotion."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(output.with_suffix(output.suffix + ".receipt.json"), receipt)
    return receipt


class PlanBatchSampler:
    """Replay a sealed plan directly from Sidepus objects with parallel prefetch."""

    def __init__(
        self,
        plan: pathlib.Path,
        receipt: pathlib.Path,
        *,
        batch_size: int,
        sequence_length: int,
        workers: int = 4,
        verify_objects: bool = True,
    ) -> None:
        self.plan_path = plan.expanduser().resolve()
        self.receipt_path = receipt.expanduser().resolve()
        self.receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        body = dict(self.receipt)
        expected_receipt_digest = body.pop("receipt_digest", None)
        if self.receipt.get("schema") != PLAN_RECEIPT_SCHEMA:
            raise ValueError("unsupported Sidepus plan receipt")
        if expected_receipt_digest != digest_json(body):
            raise ValueError("Sidepus plan receipt digest is invalid")
        if sha256_file(self.plan_path) != self.receipt.get("plan_sha256"):
            raise ValueError("Sidepus plan file does not match receipt")
        if int(self.receipt.get("sequence_length", -1)) != sequence_length:
            raise ValueError("Sidepus plan sequence length differs from trainer")
        self.rows = read_jsonl(self.plan_path)
        if len(self.rows) != int(self.receipt.get("samples", -1)):
            raise ValueError("Sidepus plan row count differs from receipt")
        self.batch_size = batch_size
        self.sequence_length = sequence_length
        self.cursor = 0
        self.store = ObjectStore(pathlib.Path(self.receipt["state_dir"]), verify=verify_objects)
        self.renderers: dict[str, EpisodeRenderer] = {}
        self.records = self._load_record_index(pathlib.Path(self.receipt["inventory"]))
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers))

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)

    def __enter__(self) -> "PlanBatchSampler":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _load_record_index(inventory: pathlib.Path) -> dict[str, Record]:
        result: dict[str, Record] = {}
        for raw in read_jsonl(inventory):
            try:
                record = Record.from_inventory(raw)
            except ValueError:
                continue
            result[record.record_id] = record
        return result

    def state_dict(self) -> dict[str, int]:
        return {"cursor": self.cursor}

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        cursor = int(state.get("cursor", 0))
        if not 0 <= cursor <= len(self.rows):
            raise ValueError("Sidepus plan cursor is outside the plan")
        self.cursor = cursor

    def _renderer(self, mode: str) -> EpisodeRenderer:
        renderer = self.renderers.get(mode)
        if renderer is None:
            renderer = EpisodeRenderer(self.store, mode)
            self.renderers[mode] = renderer
        return renderer

    def _materialize(self, row: Mapping[str, Any]) -> list[int]:
        if row.get("schema") != PLAN_ROW_SCHEMA:
            raise ValueError("unsupported Sidepus plan row")
        renderer = self._renderer(str(row["render_mode"]))
        stream: list[int] = []
        for fragment in row["fragments"]:
            record_id = str(fragment["record_id"])
            record = self.records.get(record_id)
            if record is None:
                raise ValueError(f"Sidepus record vanished from inventory: {record_id}")
            tokens, digest = renderer.render(record)
            if digest != fragment.get("episode_sha256") or len(tokens) != int(fragment["token_count"]):
                raise ValueError(f"Sidepus episode changed: {record_id}")
            stream.extend(tokens)
        start = int(row["window_start"])
        length = int(row["window_tokens"])
        window = stream[start:start + length]
        if len(window) != self.sequence_length + 1:
            raise ValueError("Sidepus plan materialized an incomplete window")
        window_bytes = b"".join(int(token).to_bytes(2, "little") for token in window)
        if hashlib.sha256(window_bytes).hexdigest() != row.get("window_sha256"):
            raise ValueError("Sidepus replay window digest mismatch")
        return window

    def batch_with_rows(self, device: torch.device) -> tuple[torch.Tensor, list[dict[str, Any]]]:
        if self.cursor + self.batch_size > len(self.rows):
            raise StopIteration("Sidepus direct plan exhausted")
        selected = [dict(row) for row in self.rows[self.cursor:self.cursor + self.batch_size]]
        futures = [self.executor.submit(self._materialize, row) for row in selected]
        materialized = [future.result() for future in futures]
        self.cursor += self.batch_size
        return torch.tensor(materialized, dtype=torch.long, device=device), selected

    def batch(self, device: torch.device) -> torch.Tensor:
        batch, _ = self.batch_with_rows(device)
        return batch


def _parse_domain_targets(value: str | None) -> dict[str, float] | None:
    if not value:
        return None
    path = pathlib.Path(value)
    payload: Any
    if path.is_file():
        payload = json.loads(path.read_text(encoding="utf-8"))
    else:
        payload = json.loads(value)
    if not isinstance(payload, dict):
        raise ValueError("domain targets must be a JSON object")
    return {str(key): float(weight) for key, weight in payload.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--state-dir", required=True)
    plan.add_argument("--inventory", required=True)
    plan.add_argument("--output", required=True)
    plan.add_argument("--samples", type=int, required=True)
    plan.add_argument("--sequence-length", type=int, default=1024)
    plan.add_argument("--seed", type=int, default=20260723)
    plan.add_argument(
        "--render-mode",
        choices=("multichannel", "utterance-only", "flattened-control", "structure-only"),
        default="multichannel",
    )
    plan.add_argument("--minimum-quality", type=float, default=0.35)
    plan.add_argument("--require-channel", action="append", default=["utterance"])
    plan.add_argument("--exclude-flag", action="append", default=["rights-blocked"])
    plan.add_argument("--domain-targets")
    args = parser.parse_args()
    if args.command == "plan":
        receipt = build_plan(
            state_dir=pathlib.Path(args.state_dir),
            inventory=pathlib.Path(args.inventory),
            output=pathlib.Path(args.output),
            samples=args.samples,
            sequence_length=args.sequence_length,
            seed=args.seed,
            render_mode=args.render_mode,
            minimum_quality=args.minimum_quality,
            required_channels=args.require_channel,
            excluded_flags=args.exclude_flag,
            domain_targets=_parse_domain_targets(args.domain_targets),
        )
        print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
