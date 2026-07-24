#!/usr/bin/env python3
"""Partition Sidepus inventory into disjoint evidence islands before plan sampling."""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import pathlib
import tempfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from sidepus_pursuit_plan import (
    MODEL_VISIBLE_CHANNELS,
    digest_json,
    effective_object_ref,
    read_jsonl,
    sha256_file,
    stable_json,
)

SPLIT_SCHEMA = "sidepus-evidence-island-split/v1"
SPLIT_RECEIPT_SCHEMA = "sidepus-evidence-island-receipt/v1"
SPLIT_NAMES = ("train", "development", "admission")
LINEAGE_FIELDS = (
    "sequence_id",
    "episode_id",
    "thread_id",
    "trajectory_id",
    "conversation_id",
)


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left: int, right: int) -> None:
        a, b = self.find(left), self.find(right)
        if a == b:
            return
        if self.rank[a] < self.rank[b]:
            a, b = b, a
        self.parent[b] = a
        if self.rank[a] == self.rank[b]:
            self.rank[a] += 1


@dataclass(frozen=True)
class EvidenceIsland:
    digest: str
    indices: tuple[int, ...]
    domain_counts: Mapping[str, int]
    lineages: tuple[str, ...]
    linked_object_shas: tuple[str, ...]

    @property
    def records(self) -> int:
        return len(self.indices)


def _atomic_jsonl(path: pathlib.Path, rows: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            for row in rows:
                handle.write(stable_json(dict(row)) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise


def _atomic_json(path: pathlib.Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(dict(value), indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise


def lineage_keys(record: Mapping[str, Any]) -> tuple[str, ...]:
    keys: list[str] = []
    for field in LINEAGE_FIELDS:
        value = record.get(field)
        text = str(value).strip() if value is not None else ""
        if text:
            keys.append(f"{field}:{text}")
    return tuple(sorted(set(keys)))


def visible_object_shas(record: Mapping[str, Any]) -> tuple[str, ...]:
    objects = record.get("channel_objects")
    if not isinstance(objects, Mapping):
        return ()
    values: set[str] = set()
    for channel in MODEL_VISIBLE_CHANNELS:
        items = objects.get(channel, [])
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, Mapping):
                continue
            target = effective_object_ref(item)
            for key in ("sha256", "source_object_sha256"):
                value = str(target.get(key, "")).strip().lower()
                if value:
                    values.add(value)
    return tuple(sorted(values))


def build_islands(
    rows: list[dict[str, Any]], *, maximum_link_frequency: int,
) -> tuple[list[EvidenceIsland], dict[str, int]]:
    if maximum_link_frequency < 2:
        raise ValueError("maximum_link_frequency must be at least two")
    union = UnionFind(len(rows))
    lineages_by_index = [lineage_keys(row) for row in rows]
    objects_by_index = [visible_object_shas(row) for row in rows]

    lineage_owner: dict[str, int] = {}
    for index, keys in enumerate(lineages_by_index):
        for key in keys:
            if key in lineage_owner:
                union.union(index, lineage_owner[key])
            else:
                lineage_owner[key] = index

    object_members: dict[str, list[int]] = collections.defaultdict(list)
    for index, values in enumerate(objects_by_index):
        for value in values:
            object_members[value].append(index)
    linked_objects = {
        value: members
        for value, members in object_members.items()
        if 2 <= len(members) <= maximum_link_frequency
    }
    for members in linked_objects.values():
        anchor = members[0]
        for index in members[1:]:
            union.union(anchor, index)

    grouped: dict[int, list[int]] = collections.defaultdict(list)
    for index in range(len(rows)):
        grouped[union.find(index)].append(index)

    islands: list[EvidenceIsland] = []
    for members in grouped.values():
        domains = collections.Counter(str(rows[index].get("domain", "unknown")) for index in members)
        lineages = sorted({value for index in members for value in lineages_by_index[index]})
        objects = sorted({
            value
            for index in members
            for value in objects_by_index[index]
            if value in linked_objects
        })
        identity = {
            "record_ids": sorted(str(rows[index].get("record_id", "")) for index in members),
            "lineages": lineages,
            "linked_object_shas": objects,
        }
        islands.append(EvidenceIsland(
            digest=digest_json(identity),
            indices=tuple(sorted(members)),
            domain_counts=dict(sorted(domains.items())),
            lineages=tuple(lineages),
            linked_object_shas=tuple(objects),
        ))
    islands.sort(key=lambda island: (-island.records, island.digest))
    diagnostics = {
        "records": len(rows),
        "islands": len(islands),
        "explicit_lineages": len(lineage_owner),
        "model_visible_object_shas": len(object_members),
        "linked_object_shas": len(linked_objects),
        "common_object_shas": sum(len(members) > maximum_link_frequency for members in object_members.values()),
    }
    return islands, diagnostics


def _normalized_ratios(train: float, development: float, admission: float) -> dict[str, float]:
    values = {"train": train, "development": development, "admission": admission}
    if any(not math.isfinite(value) or value <= 0 for value in values.values()):
        raise ValueError("all split fractions must be finite and positive")
    total = sum(values.values())
    return {name: value / total for name, value in values.items()}


def assign_islands(
    islands: list[EvidenceIsland], *, ratios: Mapping[str, float], seed: int,
) -> dict[str, list[EvidenceIsland]]:
    if len(islands) < len(SPLIT_NAMES):
        raise ValueError("at least three evidence islands are required")
    total_records = sum(island.records for island in islands)
    domains = sorted({domain for island in islands for domain in island.domain_counts})
    total_domains = collections.Counter()
    for island in islands:
        total_domains.update(island.domain_counts)

    target_records = {name: total_records * ratios[name] for name in SPLIT_NAMES}
    target_domains = {
        name: {domain: total_domains[domain] * ratios[name] for domain in domains}
        for name in SPLIT_NAMES
    }
    assigned = {name: [] for name in SPLIT_NAMES}
    record_counts = collections.Counter()
    domain_counts = {name: collections.Counter() for name in SPLIT_NAMES}

    for position, island in enumerate(islands):
        remaining = len(islands) - position
        empty = [name for name in SPLIT_NAMES if not assigned[name]]
        candidates = empty if empty and remaining <= len(empty) else list(SPLIT_NAMES)
        scored: list[tuple[float, str, str]] = []
        for name in candidates:
            total_deficit = (target_records[name] - record_counts[name]) / max(target_records[name], 1.0)
            domain_terms = []
            for domain, count in island.domain_counts.items():
                deficit = target_domains[name][domain] - domain_counts[name][domain]
                domain_terms.append((deficit / max(target_domains[name][domain], 1.0)) * count)
            domain_score = sum(domain_terms) / max(island.records, 1)
            overflow = max(0.0, record_counts[name] + island.records - target_records[name]) / max(target_records[name], 1.0)
            tie = digest_json([seed, island.digest, name])
            scored.append((total_deficit + domain_score - 0.5 * overflow, tie, name))
        _, _, selected = max(scored)
        assigned[selected].append(island)
        record_counts[selected] += island.records
        domain_counts[selected].update(island.domain_counts)

    if any(not assigned[name] for name in SPLIT_NAMES):
        raise RuntimeError("evidence-island assignment produced an empty split")
    return assigned


def _set_overlap(left: set[str], right: set[str]) -> int:
    return len(left & right)


def split_inventory(
    *, inventory: pathlib.Path, output_dir: pathlib.Path, seed: int,
    train_fraction: float, development_fraction: float, admission_fraction: float,
    maximum_link_frequency: int,
) -> dict[str, Any]:
    inventory = inventory.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    rows = read_jsonl(inventory)
    if not rows:
        raise ValueError("inventory is empty")
    record_ids = [str(row.get("record_id", "")) for row in rows]
    if any(not value for value in record_ids) or len(set(record_ids)) != len(record_ids):
        raise ValueError("inventory record_id values must be nonempty and unique")

    ratios = _normalized_ratios(train_fraction, development_fraction, admission_fraction)
    islands, island_diagnostics = build_islands(rows, maximum_link_frequency=maximum_link_frequency)
    assignments = assign_islands(islands, ratios=ratios, seed=seed)

    summaries: dict[str, Any] = {}
    identity_sets: dict[str, dict[str, set[str]]] = {}
    for name in SPLIT_NAMES:
        indices = sorted(index for island in assignments[name] for index in island.indices)
        selected = [rows[index] for index in indices]
        path = output_dir / f"{name}-inventory.jsonl"
        _atomic_jsonl(path, selected)
        domains = collections.Counter(str(row.get("domain", "unknown")) for row in selected)
        lineages = {value for row in selected for value in lineage_keys(row)}
        linked_objects = {
            value
            for island in assignments[name]
            for value in island.linked_object_shas
        }
        all_objects = {value for row in selected for value in visible_object_shas(row)}
        ids = {str(row["record_id"]) for row in selected}
        identity_sets[name] = {
            "record_ids": ids,
            "lineages": lineages,
            "linked_object_shas": linked_objects,
            "all_object_shas": all_objects,
        }
        summaries[name] = {
            "path": str(path),
            "sha256": sha256_file(path),
            "records": len(selected),
            "islands": len(assignments[name]),
            "record_id_digest": digest_json(sorted(ids)),
            "lineage_digest": digest_json(sorted(lineages)),
            "linked_object_digest": digest_json(sorted(linked_objects)),
            "domains": dict(sorted(domains.items())),
        }

    pairwise: dict[str, Any] = {}
    for left_index, left in enumerate(SPLIT_NAMES):
        for right in SPLIT_NAMES[left_index + 1:]:
            pairwise[f"{left}_vs_{right}"] = {
                "record_id_overlap": _set_overlap(identity_sets[left]["record_ids"], identity_sets[right]["record_ids"]),
                "lineage_overlap": _set_overlap(identity_sets[left]["lineages"], identity_sets[right]["lineages"]),
                "linked_object_overlap": _set_overlap(
                    identity_sets[left]["linked_object_shas"], identity_sets[right]["linked_object_shas"]
                ),
                "all_object_overlap": _set_overlap(
                    identity_sets[left]["all_object_shas"], identity_sets[right]["all_object_shas"]
                ),
            }
    hard_overlap = any(
        values[key] > 0
        for values in pairwise.values()
        for key in ("record_id_overlap", "lineage_overlap", "linked_object_overlap")
    )
    if hard_overlap:
        raise RuntimeError("evidence island split leaked a record, lineage, or identifying object")

    receipt: dict[str, Any] = {
        "schema": SPLIT_RECEIPT_SCHEMA,
        "split_schema": SPLIT_SCHEMA,
        "source_inventory": str(inventory),
        "source_inventory_sha256": sha256_file(inventory),
        "seed": seed,
        "ratios": ratios,
        "maximum_link_frequency": maximum_link_frequency,
        "island_diagnostics": island_diagnostics,
        "splits": summaries,
        "pairwise_overlap": pairwise,
        "hard_disjoint": True,
        "claim_boundary": (
            "Records sharing an explicit lineage or an identifying model-visible object digest are assigned to one split. "
            "Very common object digests are reported but treated as shared primitives rather than identity links."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    _atomic_json(output_dir / "evidence-split-receipt.json", receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=20260723)
    parser.add_argument("--train-fraction", type=float, default=0.80)
    parser.add_argument("--development-fraction", type=float, default=0.10)
    parser.add_argument("--admission-fraction", type=float, default=0.10)
    parser.add_argument("--maximum-link-frequency", type=int, default=64)
    args = parser.parse_args()
    print(json.dumps(split_inventory(
        inventory=pathlib.Path(args.inventory),
        output_dir=pathlib.Path(args.output_dir),
        seed=args.seed,
        train_fraction=args.train_fraction,
        development_fraction=args.development_fraction,
        admission_fraction=args.admission_fraction,
        maximum_link_frequency=args.maximum_link_frequency,
    ), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
