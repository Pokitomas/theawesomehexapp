#!/usr/bin/env python3
"""Fail-closed gate for creating an Archie Event Clock candidate.

No event-clock model code is authorized until a verified linked-recurrence report
clears every predeclared matched-control condition.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
from dataclasses import dataclass
from typing import Any

REPORT_SCHEMA = "archie-linked-recurrence-report/v1"
PROTOCOL_SCHEMA = "archie-event-clock-protocol/v1"
AUTHORIZATION_SCHEMA = "archie-event-clock-authorization/v1"


@dataclass(frozen=True)
class Thresholds:
    minimum_seed_count: int
    minimum_carried_gain_bpb: float
    minimum_transplant_penalty_bpb: float
    minimum_shuffle_penalty_bpb: float
    maximum_logit_parity_error: float
    maximum_retention_regression_bpb: float


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def validate_protocol(protocol: dict[str, Any]) -> Thresholds:
    if protocol.get("schema") != PROTOCOL_SCHEMA:
        raise ValueError("unsupported Event Clock protocol")
    if protocol.get("blocked_by") != [733, 734]:
        raise ValueError("Event Clock protocol must remain blocked by #733 and #734")
    scale = protocol.get("scale")
    if not isinstance(scale, dict) or int(scale.get("minimum_parameters", 0)) < 20_000_000:
        raise ValueError("prototype scale floor is missing")
    if int(scale.get("maximum_parameters", 0)) > 30_000_000:
        raise ValueError("prototype exceeds the authorized 30M parameter ceiling")
    controls = protocol.get("controls")
    if not isinstance(controls, dict) or set(controls) != {"A", "B", "C", "D", "E"}:
        raise ValueError("all five matched controls A-E are required")
    raw = protocol.get("recurrence_gate")
    if not isinstance(raw, dict):
        raise ValueError("recurrence gate is missing")
    thresholds = Thresholds(
        minimum_seed_count=int(raw["minimum_seed_count"]),
        minimum_carried_gain_bpb=float(raw["minimum_carried_gain_bpb"]),
        minimum_transplant_penalty_bpb=float(raw["minimum_transplant_penalty_bpb"]),
        minimum_shuffle_penalty_bpb=float(raw["minimum_shuffle_penalty_bpb"]),
        maximum_logit_parity_error=float(raw["maximum_logit_parity_error"]),
        maximum_retention_regression_bpb=float(raw["maximum_retention_regression_bpb"]),
    )
    if thresholds.minimum_seed_count < 3:
        raise ValueError("at least three recurrence seeds are required")
    expected = protocol.get("protocol_digest")
    canonical = dict(protocol)
    canonical.pop("protocol_digest", None)
    if expected != digest(canonical):
        raise ValueError("Event Clock protocol digest mismatch")
    return thresholds


def evaluate_recurrence_gate(report: dict[str, Any], thresholds: Thresholds) -> dict[str, Any]:
    failures: list[str] = []
    if report.get("schema") != REPORT_SCHEMA:
        failures.append("unsupported-recurrence-report-schema")
    if report.get("verified") is not True:
        failures.append("recurrence-report-not-independently-verified")
    if report.get("promotion") != "research-only-not-admitted":
        failures.append("recurrence-promotion-boundary-drift")
    if not report.get("baseline_model_sha256") or not report.get("fixed_eval_receipt_sha256"):
        failures.append("missing-baseline-or-fixed-eval-identity")
    seeds = report.get("seeds")
    if not isinstance(seeds, list):
        seeds = []
    if len(seeds) < thresholds.minimum_seed_count:
        failures.append("insufficient-seed-count")
    checked: list[dict[str, Any]] = []
    for item in seeds:
        if not isinstance(item, dict):
            failures.append("malformed-seed-record")
            continue
        seed = int(item.get("seed", -1))
        carried = float(item.get("carried_bpb", float("inf")))
        reset = float(item.get("reset_bpb", float("inf")))
        transplant = float(item.get("transplanted_bpb", float("-inf")))
        shuffled = float(item.get("shuffled_bpb", float("-inf")))
        parity = float(item.get("maximum_logit_parity_error", float("inf")))
        retention = float(item.get("ordinary_retention_regression_bpb", float("inf")))
        carried_gain = reset - carried
        transplant_penalty = transplant - carried
        shuffle_penalty = shuffled - carried
        checks = {
            "seed": seed,
            "carried_gain_bpb": carried_gain,
            "transplant_penalty_bpb": transplant_penalty,
            "shuffle_penalty_bpb": shuffle_penalty,
            "maximum_logit_parity_error": parity,
            "ordinary_retention_regression_bpb": retention,
        }
        checked.append(checks)
        if carried_gain < thresholds.minimum_carried_gain_bpb:
            failures.append(f"seed-{seed}-carried-state-gain-failed")
        if transplant_penalty < thresholds.minimum_transplant_penalty_bpb:
            failures.append(f"seed-{seed}-transplant-penalty-failed")
        if shuffle_penalty < thresholds.minimum_shuffle_penalty_bpb:
            failures.append(f"seed-{seed}-shuffle-penalty-failed")
        if parity > thresholds.maximum_logit_parity_error:
            failures.append(f"seed-{seed}-incremental-parity-failed")
        if retention > thresholds.maximum_retention_regression_bpb:
            failures.append(f"seed-{seed}-ordinary-retention-failed")
    return {
        "authorized": not failures,
        "failures": sorted(set(failures)),
        "checked_seeds": checked,
    }


def authorize(protocol_path: pathlib.Path, recurrence_report_path: pathlib.Path, output_path: pathlib.Path) -> dict[str, Any]:
    protocol = read_json(protocol_path)
    thresholds = validate_protocol(protocol)
    report = read_json(recurrence_report_path)
    gate = evaluate_recurrence_gate(report, thresholds)
    authorization: dict[str, Any] = {
        "schema": AUTHORIZATION_SCHEMA,
        "authorized": gate["authorized"],
        "protocol_digest": protocol["protocol_digest"],
        "recurrence_report_digest": digest(report),
        "baseline_model_sha256": report.get("baseline_model_sha256"),
        "fixed_eval_receipt_sha256": report.get("fixed_eval_receipt_sha256"),
        "failures": gate["failures"],
        "checked_seeds": gate["checked_seeds"],
        "allowed_action": "create-20m-to-30m-event-clock-prototype" if gate["authorized"] else "none",
        "promotion": "research-candidate-not-admitted" if gate["authorized"] else "blocked",
    }
    authorization["authorization_digest"] = digest(authorization)
    atomic_json(output_path, authorization)
    if not gate["authorized"]:
        raise SystemExit("Event Clock remains blocked: " + ", ".join(gate["failures"]))
    return authorization


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--recurrence-report", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = authorize(pathlib.Path(args.protocol), pathlib.Path(args.recurrence_report), pathlib.Path(args.output))
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
