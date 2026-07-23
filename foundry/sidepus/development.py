#!/usr/bin/env python3
"""Compile broad Sidepus inventories into governed developmental schedules."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sqlite3
import tempfile
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

from .catalog import atomic_json, digest_json, sha256_file, stable_json, utc_now

PROGRAM_SCHEMA = "sidepus-developmental-program/v1"
INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
CONTENT_POLICY_SCHEMA = "sidepus-content-policy/v2"
RECEIPT_SCHEMA = "sidepus-developmental-compilation/v1"
SCHEDULE_SCHEMA = "sidepus-developmental-schedule-row/v1"
CHANNELS = {
    "observation", "production_context", "utterance", "interpretation",
    "action_consequence", "evaluation_only",
}


def load_object(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def read_jsonl(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    with path.resolve().open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number} is not a JSON object")
            yield value


def require_digest(value: Any, label: str) -> str:
    text = str(value or "").lower()
    if len(text) != 64 or any(c not in "0123456789abcdef" for c in text):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return text


def validate_content_policy(policy: Mapping[str, Any]) -> str:
    required = {
        "purposes", "historical_sources", "fresh_capture", "languages",
        "time_ranges", "subject_allocations", "exclusions", "maximum_archive_bytes",
    }
    if policy.get("schema") != CONTENT_POLICY_SCHEMA:
        raise ValueError(f"content policy must use {CONTENT_POLICY_SCHEMA}")
    if policy.get("approved_by_operator") is not True:
        raise ValueError("content policy must record approved_by_operator=true")
    missing = sorted(required - policy.keys())
    if missing:
        raise ValueError(f"content policy is missing fields: {missing}")
    if int(policy["maximum_archive_bytes"]) < 1:
        raise ValueError("maximum_archive_bytes must be positive")
    return digest_json(dict(policy))


def validate_program(program: Mapping[str, Any]) -> dict[str, Any]:
    if program.get("schema") != PROGRAM_SCHEMA:
        raise ValueError(f"developmental program must use {PROGRAM_SCHEMA}")
    if program.get("approved_by_operator") is not True:
        raise ValueError("developmental program must record approved_by_operator=true")
    require_digest(program.get("acquisition_policy_digest"), "acquisition_policy_digest")
    taxonomy = program.get("channel_taxonomy")
    if not isinstance(taxonomy, dict) or CHANNELS - taxonomy.keys():
        raise ValueError(f"channel_taxonomy must include {sorted(CHANNELS)}")
    objectives = program.get("objectives")
    if not isinstance(objectives, dict) or not objectives:
        raise ValueError("objectives must be a nonempty object")
    for name, objective in objectives.items():
        visible = set(objective.get("visible_channels", []))
        hidden = set(objective.get("hidden_targets", []))
        if (visible | hidden) - taxonomy.keys() or visible & hidden:
            raise ValueError(f"objective {name} has invalid visible/hidden channels")
    stages = program.get("stages")
    if not isinstance(stages, list) or not stages:
        raise ValueError("stages must be a nonempty list")
    stage_ids = [str(stage.get("id", "")) for stage in stages]
    orders = [int(stage.get("order", -1)) for stage in stages]
    if "" in stage_ids or len(stage_ids) != len(set(stage_ids)):
        raise ValueError("stage ids must be unique and nonempty")
    if min(orders) < 0 or len(orders) != len(set(orders)):
        raise ValueError("stage orders must be unique and nonnegative")
    for stage in stages:
        if not stage.get("objectives") or any(x not in objectives for x in stage["objectives"]):
            raise ValueError(f"stage {stage['id']} references missing objectives")
        targets = stage.get("domain_targets", {})
        if not targets or abs(sum(map(float, targets.values())) - 1.0) > 1e-6:
            raise ValueError(f"stage {stage['id']} domain_targets must sum to 1")
        if int(stage.get("base_exposures", 1)) < 1 or int(stage.get("max_extra_exposures", 0)) < 0:
            raise ValueError(f"stage {stage['id']} has invalid exposure bounds")
    lineages = program.get("lineages")
    if not isinstance(lineages, list) or len(lineages) < 2:
        raise ValueError("at least two matched lineages are required")
    lineage_ids = [str(x.get("id", "")) for x in lineages]
    if "" in lineage_ids or len(lineage_ids) != len(set(lineage_ids)):
        raise ValueError("lineage ids must be unique and nonempty")
    for lineage in lineages:
        order = lineage.get("stage_order")
        if not isinstance(order, list) or len(order) != len(stage_ids) or set(order) != set(stage_ids):
            raise ValueError(f"lineage {lineage['id']} must contain every stage exactly once")
    maximum = float(program.get("allocation_guardrails", {}).get(
        "maximum_single_domain_effective_share", 0.0
    ))
    if not 0.0 < maximum <= 1.0:
        raise ValueError("maximum_single_domain_effective_share must be in (0, 1]")
    return {
        "program_digest": digest_json(dict(program)),
        "stage_ids": sorted(stage_ids),
        "lineage_ids": sorted(lineage_ids),
    }


def normalize_record(record: Mapping[str, Any]) -> dict[str, Any]:
    if record.get("schema") != INVENTORY_SCHEMA:
        raise ValueError(f"inventory record must use {INVENTORY_SCHEMA}")
    normalized = dict(record)
    normalized["record_id"] = str(record.get("record_id", "")).strip()
    normalized["object_sha256"] = require_digest(record.get("object_sha256"), "object_sha256")
    normalized["bytes"] = int(record.get("bytes", 0))
    normalized["estimated_tokens"] = int(record.get("estimated_tokens", 0))
    normalized["domain"] = str(record.get("domain", "")).strip()
    normalized["medium"] = str(record.get("medium", "")).strip()
    normalized["language"] = str(record.get("language", "und")).strip() or "und"
    normalized["era"] = str(record.get("era", "unknown")).strip() or "unknown"
    normalized["quality_score"] = float(record.get("quality_score", 0.0))
    normalized["channels"] = sorted(set(map(str, record.get("channels", []))))
    normalized["flags"] = sorted(set(map(str, record.get("flags", []))))
    if not normalized["record_id"] or not normalized["domain"] or not normalized["medium"]:
        raise ValueError("inventory record requires record_id, domain, and medium")
    if normalized["bytes"] < 1 or normalized["estimated_tokens"] < 1:
        raise ValueError(f"inventory record {normalized['record_id']} has invalid size")
    if not 0.0 <= normalized["quality_score"] <= 1.0:
        raise ValueError(f"inventory record {normalized['record_id']} has invalid quality_score")
    if not normalized["channels"] or set(normalized["channels"]) - CHANNELS:
        raise ValueError(f"inventory record {normalized['record_id']} has invalid channels")
    return normalized


def matches(record: Mapping[str, Any], selector: Mapping[str, Any]) -> bool:
    for selector_key, record_key in {
        "domains": "domain", "media": "medium", "languages": "language", "eras": "era",
    }.items():
        allowed = selector.get(selector_key)
        if allowed and record[record_key] not in set(map(str, allowed)):
            return False
    if float(record["quality_score"]) < float(selector.get("minimum_quality", 0.0)):
        return False
    if not set(map(str, selector.get("require_channels", []))).issubset(record["channels"]):
        return False
    if set(map(str, selector.get("exclude_flags", []))) & set(record["flags"]):
        return False
    return True


def rank(program: str, lineage: str, stage: str, record: str) -> str:
    return hashlib.sha256("\x1f".join((program, lineage, stage, record)).encode()).hexdigest()


def channels_for(program: Mapping[str, Any], stage: Mapping[str, Any], lineage: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    visible: set[str] = set()
    hidden: set[str] = set()
    for name in stage["objectives"]:
        visible.update(program["objectives"][name].get("visible_channels", []))
        hidden.update(program["objectives"][name].get("hidden_targets", []))
    override = lineage.get("objective_overrides", {}).get(stage["id"], {})
    visible.update(override.get("add_visible_channels", []))
    visible.difference_update(override.get("remove_visible_channels", []))
    hidden.update(override.get("add_hidden_targets", []))
    hidden.difference_update(override.get("remove_hidden_targets", []))
    return visible, hidden - visible


def database(path: pathlib.Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
    CREATE TABLE records(record_id TEXT PRIMARY KEY, object_sha256 TEXT, bytes INTEGER,
      estimated_tokens INTEGER, domain TEXT, medium TEXT, language TEXT, era TEXT,
      quality_score REAL, channels_json TEXT, flags_json TEXT, record_json TEXT);
    CREATE TABLE candidates(lineage TEXT, stage TEXT, record_id TEXT, domain TEXT,
      estimated_tokens INTEGER, rank TEXT, exposures INTEGER,
      PRIMARY KEY(lineage, stage, record_id));
    CREATE INDEX candidate_order ON candidates(lineage, stage, domain, rank);
    """)
    return db


def ingest(db: sqlite3.Connection, paths: Iterable[pathlib.Path]) -> dict[str, Any]:
    digest = hashlib.sha256()
    counts = Counter()
    totals = Counter()
    for path in paths:
        for raw in read_jsonl(path):
            record = normalize_record(raw)
            encoded = stable_json(record)
            digest.update((encoded + "\n").encode())
            try:
                db.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                    record["record_id"], record["object_sha256"], record["bytes"],
                    record["estimated_tokens"], record["domain"], record["medium"],
                    record["language"], record["era"], record["quality_score"],
                    stable_json(record["channels"]), stable_json(record["flags"]), encoded,
                ))
            except sqlite3.IntegrityError as error:
                raise ValueError(f"duplicate inventory record_id: {record['record_id']}") from error
            counts[record["domain"]] += 1
            totals["records"] += 1
            totals["bytes"] += record["bytes"]
            totals["estimated_tokens"] += record["estimated_tokens"]
    if not totals["records"]:
        raise ValueError("developmental inventory is empty")
    db.commit()
    return {**totals, "domains": dict(sorted(counts.items())), "inventory_digest": digest.hexdigest()}


def build_candidates(db: sqlite3.Connection, program: Mapping[str, Any], digest: str) -> dict[str, int]:
    stages = {x["id"]: x for x in program["stages"]}
    counts: dict[str, int] = {}
    for lineage in program["lineages"]:
        for stage_id in lineage["stage_order"]:
            stage = stages[stage_id]
            selected = 0
            for row in db.execute("SELECT record_json FROM records ORDER BY record_id"):
                record = json.loads(row[0])
                if matches(record, stage.get("selector", {})):
                    db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?)", (
                        lineage["id"], stage_id, record["record_id"], record["domain"],
                        record["estimated_tokens"], rank(digest, lineage["id"], stage_id, record["record_id"]),
                        int(stage.get("base_exposures", 1)),
                    ))
                    selected += 1
            if not selected:
                raise ValueError(f"lineage {lineage['id']} stage {stage_id} selected no records")
            counts[f"{lineage['id']}:{stage_id}"] = selected
    db.commit()
    return counts


def allocate(db: sqlite3.Connection, program: Mapping[str, Any]) -> dict[str, Any]:
    stages = {x["id"]: x for x in program["stages"]}
    summaries = {}
    for lineage in program["lineages"]:
        for stage_id in lineage["stage_order"]:
            stage = stages[stage_id]
            base = int(db.execute(
                "SELECT COALESCE(SUM(estimated_tokens*exposures),0) FROM candidates WHERE lineage=? AND stage=?",
                (lineage["id"], stage_id),
            ).fetchone()[0])
            budget = int(base * float(stage.get("supplemental_fraction", 0.0)))
            added = Counter()
            for domain, share in sorted(stage["domain_targets"].items()):
                target = int(budget * float(share))
                for _ in range(int(stage.get("max_extra_exposures", 0))):
                    for row in db.execute(
                        "SELECT record_id,estimated_tokens FROM candidates WHERE lineage=? AND stage=? AND domain=? ORDER BY rank",
                        (lineage["id"], stage_id, domain),
                    ):
                        if added[domain] >= target:
                            break
                        db.execute(
                            "UPDATE candidates SET exposures=exposures+1 WHERE lineage=? AND stage=? AND record_id=?",
                            (lineage["id"], stage_id, row["record_id"]),
                        )
                        added[domain] += int(row["estimated_tokens"])
                    if added[domain] >= target:
                        break
            db.commit()
            summaries[f"{lineage['id']}:{stage_id}"] = {
                "base_effective_tokens": base,
                "supplemental_budget_tokens": budget,
                "supplemental_allocated_tokens": sum(added.values()),
                "supplemental_by_domain": dict(sorted(added.items())),
            }
    return summaries


def write_schedule(db: sqlite3.Connection, program: Mapping[str, Any], digest: str, path: pathlib.Path) -> dict[str, Any]:
    stages = {x["id"]: x for x in program["stages"]}
    totals = Counter()
    domains = Counter()
    with path.open("w", encoding="utf-8") as handle:
        for lineage in program["lineages"]:
            for index, stage_id in enumerate(lineage["stage_order"]):
                stage = stages[stage_id]
                visible, hidden = channels_for(program, stage, lineage)
                rows = db.execute("""SELECT c.*,r.medium,r.language,r.era,r.object_sha256,r.channels_json
                  FROM candidates c JOIN records r USING(record_id)
                  WHERE c.lineage=? AND c.stage=? ORDER BY c.rank""", (lineage["id"], stage_id))
                for row in rows:
                    available = set(json.loads(row["channels_json"]))
                    tokens = int(row["estimated_tokens"]) * int(row["exposures"])
                    payload = {
                        "schema": SCHEDULE_SCHEMA, "program_digest": digest,
                        "lineage": lineage["id"], "stage": stage_id, "stage_order_index": index,
                        "record_id": row["record_id"], "object_sha256": row["object_sha256"],
                        "domain": row["domain"], "medium": row["medium"],
                        "language": row["language"], "era": row["era"],
                        "objectives": stage["objectives"],
                        "visible_channels": sorted(visible & available),
                        "hidden_targets": sorted((hidden & available) - visible),
                        "exposures": int(row["exposures"]),
                        "estimated_effective_tokens": tokens, "deterministic_rank": row["rank"],
                    }
                    handle.write(stable_json(payload) + "\n")
                    totals["rows"] += 1
                    totals["effective_tokens"] += tokens
                    domains[row["domain"]] += tokens
        handle.flush(); os.fsync(handle.fileno())
    observed = max(domains.values(), default=0) / max(totals["effective_tokens"], 1)
    maximum = float(program["allocation_guardrails"]["maximum_single_domain_effective_share"])
    return {**totals, "path": str(path.resolve()), "sha256": sha256_file(path),
        "effective_tokens_by_domain": dict(sorted(domains.items())),
        "maximum_single_domain_effective_share": observed,
        "maximum_single_domain_guardrail": maximum, "guardrail_passed": observed <= maximum}


def ablation(program: Mapping[str, Any], digest: str) -> dict[str, Any]:
    lineages = [{k: x.get(k) for k in ("id", "role", "stage_order", "intervention", "matched_resource_group")}
        for x in program["lineages"]]
    experiments = [x for x in lineages if x["role"] != "control"]
    controls = [x for x in lineages if x["role"] == "control"]
    comparisons = [{"experimental": e["id"], "control": c["id"],
        "required_equalities": ["parameter_count", "optimizer", "token_budget", "checkpoint_cadence", "evaluation_inventory"]}
        for e in experiments for c in controls if e["matched_resource_group"] == c["matched_resource_group"]]
    body = {"schema": "sidepus-developmental-ablation-manifest/v1", "program_digest": digest,
        "lineages": lineages, "comparisons": comparisons, "falsification_rule": program.get("falsification_rule")}
    body["manifest_digest"] = digest_json(body)
    return body


def compile_program(*, program_path: pathlib.Path, content_policy_path: pathlib.Path,
    inventory_paths: Iterable[pathlib.Path], output_dir: pathlib.Path) -> dict[str, Any]:
    program = load_object(program_path)
    validation = validate_program(program)
    policy = load_object(content_policy_path)
    policy_digest = validate_content_policy(policy)
    if policy_digest != program["acquisition_policy_digest"]:
        raise ValueError("developmental program is not bound to the supplied acquisition content policy")
    output_dir = output_dir.expanduser().resolve(); output_dir.mkdir(parents=True, exist_ok=True)
    schedule_path = output_dir / "developmental-schedule.jsonl"
    receipt_path = output_dir / "developmental-receipt.json"
    ablation_path = output_dir / "ablation-manifest.json"
    if any(x.exists() for x in (schedule_path, receipt_path, ablation_path)):
        raise ValueError("refusing to overwrite an existing developmental compilation")
    with tempfile.TemporaryDirectory(dir=output_dir) as temporary:
        db = database(pathlib.Path(temporary) / "development.sqlite3")
        try:
            inventory = ingest(db, inventory_paths)
            candidates = build_candidates(db, program, validation["program_digest"])
            allocation = allocate(db, program)
            schedule = write_schedule(db, program, validation["program_digest"], schedule_path)
        finally:
            db.close()
    manifest = ablation(program, validation["program_digest"]); atomic_json(ablation_path, manifest)
    receipt = {"schema": RECEIPT_SCHEMA, "created_at": utc_now(),
        "program_path": str(program_path.resolve()), "program_file_sha256": sha256_file(program_path.resolve()),
        "program_digest": validation["program_digest"], "content_policy_path": str(content_policy_path.resolve()),
        "content_policy_file_sha256": sha256_file(content_policy_path.resolve()),
        "content_policy_digest": policy_digest, "inventory": inventory, "candidate_counts": candidates,
        "allocation": allocation, "schedule": schedule,
        "ablation_manifest": {"path": str(ablation_path), "sha256": sha256_file(ablation_path),
            "manifest_digest": manifest["manifest_digest"]},
        "claim_boundary": "This proves deterministic selection, channel separation, and matched schedules; it does not prove learning or superiority."}
    receipt["receipt_digest"] = digest_json(receipt); atomic_json(receipt_path, receipt)
    if not schedule["guardrail_passed"]:
        raise ValueError("compiled schedule violates maximum_single_domain_effective_share")
    return receipt


def verify_compilation(receipt_path: pathlib.Path) -> dict[str, Any]:
    receipt = load_object(receipt_path)
    body = dict(receipt); expected = body.pop("receipt_digest", None)
    checks = {
        "schema": receipt.get("schema") == RECEIPT_SCHEMA,
        "receipt_digest": expected == digest_json(body),
        "program_file": sha256_file(pathlib.Path(receipt["program_path"])) == receipt["program_file_sha256"],
        "content_policy_file": sha256_file(pathlib.Path(receipt["content_policy_path"])) == receipt["content_policy_file_sha256"],
        "schedule_file": sha256_file(pathlib.Path(receipt["schedule"]["path"])) == receipt["schedule"]["sha256"],
        "ablation_file": sha256_file(pathlib.Path(receipt["ablation_manifest"]["path"])) == receipt["ablation_manifest"]["sha256"],
        "allocation_guardrail": bool(receipt["schedule"]["guardrail_passed"]),
    }
    return {"schema": "sidepus-developmental-verification/v1", "receipt": str(receipt_path.resolve()),
        "checks": checks, "passed": all(checks.values())}
