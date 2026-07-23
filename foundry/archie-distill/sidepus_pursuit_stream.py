#!/usr/bin/env python3
"""Active Sidepus stream with just-in-time materialization and replay sealing."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import pathlib
from collections.abc import Mapping, Sequence
from typing import Any

import torch

from archie_hybrid_core import BOS_ID, EOS_ID, SEP_ID, ByteTokenizer
from sidepus_ephemeral_cache import EphemeralObjectCache
from sidepus_pursuit_controller import PursuitController
from sidepus_pursuit_plan import (
    CHANNELS, INTENT_RECEIPT_SCHEMA, build_intent_plan, digest_json, object_refs,
    read_jsonl, sha256_file, stable_json, authorized,
)

LEDGER_ROW_SCHEMA = "sidepus-pursuit-materialization/v1"
TEXT_MEDIA_TYPES = {
    "application/json", "application/ld+json", "application/xml",
    "application/xhtml+xml", "application/javascript",
}


class PursuitExperienceStream:
    """Select from a bounded lookahead, fetch only selected objects, and seal exact windows."""

    def __init__(
        self, plan: pathlib.Path, receipt: pathlib.Path, *, state_dir: pathlib.Path,
        cache_dir: pathlib.Path, cache_bytes: int, batch_size: int, sequence_length: int,
        workers: int = 4, lookahead: int = 64, seed: int = 20260723,
        ledger: pathlib.Path | None = None,
    ) -> None:
        self.plan_path, self.receipt_path = plan.expanduser().resolve(), receipt.expanduser().resolve()
        self.receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        body, expected = dict(self.receipt), self.receipt.get("receipt_digest")
        body.pop("receipt_digest", None)
        if self.receipt.get("schema") != INTENT_RECEIPT_SCHEMA or expected != digest_json(body):
            raise ValueError("invalid pursuit plan receipt")
        if sha256_file(self.plan_path) != self.receipt.get("plan_sha256"):
            raise ValueError("pursuit plan digest mismatch")
        if int(self.receipt.get("sequence_length", -1)) != sequence_length:
            raise ValueError("pursuit plan sequence length mismatch")
        self.rows = read_jsonl(self.plan_path)
        self.inventory_path = pathlib.Path(self.receipt["inventory"])
        if sha256_file(self.inventory_path) != self.receipt.get("inventory_sha256"):
            raise ValueError("pursuit inventory digest mismatch")
        self.records = {
            str(row.get("record_id")): row for row in read_jsonl(self.inventory_path) if authorized(row)
        }
        self.batch_size, self.sequence_length = batch_size, sequence_length
        self.lookahead, self.source_cursor, self.consumed = max(batch_size, lookahead), 0, 0
        self.reservoir: list[int] = []
        self.controller = PursuitController(seed=seed)
        self.cache = EphemeralObjectCache(
            permanent_state_dir=state_dir, cache_dir=cache_dir, maximum_bytes=cache_bytes,
        )
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers))
        self.ledger_path = (ledger or self.plan_path.with_suffix(".materialized.jsonl")).expanduser().resolve()
        self.materialized: dict[str, dict[str, Any]] = {}
        if self.ledger_path.is_file():
            for row in read_jsonl(self.ledger_path):
                if row.get("schema") != LEDGER_ROW_SCHEMA:
                    raise ValueError("unsupported pursuit materialization ledger")
                self.materialized[str(row["intent_id"])] = row

    @property
    def cursor(self) -> int:
        return self.consumed

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.cache.close()

    def __enter__(self) -> "PursuitExperienceStream":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _fill(self) -> None:
        while len(self.reservoir) < self.lookahead and self.source_cursor < len(self.rows):
            self.reservoir.append(self.source_cursor)
            self.source_cursor += 1

    @staticmethod
    def _is_text(media_type: str) -> bool:
        mime = media_type.split(";", 1)[0].strip().lower()
        return mime.startswith("text/") or mime in TEXT_MEDIA_TYPES

    def _view(self, item: Mapping[str, Any]) -> str:
        training_view = item.get("training_view")
        target = dict(training_view) if isinstance(training_view, Mapping) else dict(item)
        payload = self.cache.read(target)
        media_type = str(target.get("media_type", item.get("media_type", "application/octet-stream")))
        if self._is_text(media_type):
            return payload.decode("utf-8", errors="replace").strip()
        return stable_json({
            "sha256": target.get("sha256"), "media_type": media_type, "bytes": len(payload),
            "representation": "adapter-required-nontext-observation", "adapter": target.get("adapter"),
        })

    def _render_episode(self, record: Mapping[str, Any]) -> list[int]:
        objects = record.get("channel_objects") if isinstance(record.get("channel_objects"), Mapping) else {}
        values: dict[str, str] = {}
        for channel in CHANNELS:
            items = objects.get(channel, []) if isinstance(objects.get(channel, []), list) else []
            values[channel] = "\n".join(self._view(item) for item in items if isinstance(item, Mapping)).strip()
        metadata = record.get("experience_metadata") if isinstance(record.get("experience_metadata"), Mapping) else {}
        vector = metadata.get("curriculum_vector") if isinstance(metadata.get("curriculum_vector"), Mapping) else {}
        parts = [
            '<sidepus:experience schema="sidepus-pursuit-experience/v1">',
            f"<record_id>{record.get('record_id')}</record_id>",
            f"<domain>{record.get('domain', 'unknown')}</domain>",
        ]
        if vector:
            parts.extend(("<affordance_hypotheses>", stable_json(vector), "</affordance_hypotheses>"))
        for channel in CHANNELS:
            if values[channel]:
                parts.extend((f"<{channel}>", values[channel], f"</{channel}>"))
        parts.append("</sidepus:experience>")
        return [BOS_ID, *ByteTokenizer.encode("\n".join(parts)), EOS_ID, SEP_ID]

    def _append_ledger(self, row: Mapping[str, Any]) -> None:
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        with self.ledger_path.open("a", encoding="utf-8") as handle:
            handle.write(stable_json(row) + "\n"); handle.flush(); os.fsync(handle.fileno())

    def _materialize(self, row: Mapping[str, Any]) -> list[int]:
        intent_id = str(row["intent_id"])
        record = self.records.get(str(row["record_id"]))
        if record is None:
            raise ValueError(f"pursuit record vanished: {row['record_id']}")
        refs = object_refs(record)
        with self.cache.pinned(refs):
            episode = self._render_episode(record)
        target = self.sequence_length + 1
        if len(episode) < target:
            episode = (episode * math.ceil(target / max(len(episode), 1)))[:target]
        maximum = len(episode) - target
        start = int(row["window_seed"]) % (maximum + 1) if maximum else 0
        window = episode[start:start + target]
        encode = lambda tokens: b"".join(int(token).to_bytes(2, "little") for token in tokens)
        sealed = {
            "schema": LEDGER_ROW_SCHEMA, "intent_id": intent_id, "record_id": row["record_id"],
            "episode_sha256": hashlib.sha256(encode(episode)).hexdigest(),
            "episode_tokens": len(episode), "window_start": start, "window_tokens": target,
            "window_sha256": hashlib.sha256(encode(window)).hexdigest(),
        }
        existing = self.materialized.get(intent_id)
        if existing is None:
            self._append_ledger(sealed); self.materialized[intent_id] = sealed
        elif existing != sealed:
            raise RuntimeError(f"pursuit materialization changed for {intent_id}")
        return window

    def batch_with_rows(self, device: torch.device) -> tuple[torch.Tensor, list[dict[str, Any]]]:
        self._fill()
        if len(self.reservoir) < self.batch_size:
            raise StopIteration("pursuit intent plan exhausted")
        candidates = [self.rows[index] for index in self.reservoir]
        positions = sorted(self.controller.choose(candidates, self.batch_size), reverse=True)
        selected_indices = [self.reservoir.pop(position) for position in positions]
        selected = [dict(self.rows[index]) for index in reversed(selected_indices)]
        windows = [future.result() for future in [self.executor.submit(self._materialize, row) for row in selected]]
        self.consumed += len(selected); self._fill()
        return torch.tensor(windows, dtype=torch.long, device=device), selected

    def feedback(
        self, rows: Sequence[Mapping[str, Any]], *, loss: float, state_utility: float,
        deliberation: float, retention_tax: float | None = None,
    ) -> None:
        self.controller.feedback(
            rows, loss=loss, state_utility=state_utility,
            deliberation=deliberation, retention_tax=retention_tax,
        )

    def target_deliberation(self, rows: Sequence[Mapping[str, Any]]) -> float:
        return self.controller.target_deliberation(rows)

    def state_dict(self) -> dict[str, Any]:
        return {
            "source_cursor": self.source_cursor, "consumed": self.consumed,
            "reservoir": list(self.reservoir), "controller": self.controller.state_dict(),
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        cursor, reservoir = int(state.get("source_cursor", 0)), list(map(int, state.get("reservoir", [])))
        if not 0 <= cursor <= len(self.rows) or any(i < 0 or i >= len(self.rows) for i in reservoir):
            raise ValueError("pursuit stream state outside plan")
        self.source_cursor, self.consumed, self.reservoir = cursor, int(state.get("consumed", 0)), reservoir
        self.controller.load_state_dict(dict(state.get("controller", {})))

    def snapshot(self) -> dict[str, Any]:
        return {
            "cursor": self.cursor, "source_cursor": self.source_cursor,
            "reservoir": len(self.reservoir), "controller_step": self.controller.global_step,
            "retention_tax": self.controller.retention_tax, "cache": self.cache.snapshot(),
            "materialized_intents": len(self.materialized),
        }


def _domain_targets(value: str | None) -> dict[str, float] | None:
    if not value:
        return None
    path = pathlib.Path(value)
    payload = json.loads(path.read_text()) if path.is_file() else json.loads(value)
    if not isinstance(payload, dict):
        raise ValueError("domain targets must be an object")
    return {str(k): float(v) for k, v in payload.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--inventory", required=True); plan.add_argument("--output", required=True)
    plan.add_argument("--samples", type=int, required=True); plan.add_argument("--sequence-length", type=int, default=1024)
    plan.add_argument("--seed", type=int, default=20260723); plan.add_argument("--minimum-quality", type=float, default=0.25)
    plan.add_argument("--require-channel", action="append", default=["utterance"])
    plan.add_argument("--exclude-flag", action="append", default=["rights-blocked"]); plan.add_argument("--domain-targets")
    args = parser.parse_args()
    print(json.dumps(build_intent_plan(
        inventory=pathlib.Path(args.inventory), output=pathlib.Path(args.output), samples=args.samples,
        sequence_length=args.sequence_length, seed=args.seed, minimum_quality=args.minimum_quality,
        required_channels=args.require_channel, excluded_flags=args.exclude_flag,
        domain_targets=_domain_targets(args.domain_targets),
    ), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
