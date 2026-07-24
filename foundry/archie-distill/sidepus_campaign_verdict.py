#!/usr/bin/env python3
"""Compare matched pursuit and sequential-control candidates on one admission court."""
from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any, Mapping

from archie_hybrid_corpus import sha256_file
from sidepus_pursuit_plan import digest_json

VERDICT_SCHEMA = "archie-sidepus-pursuit-admission-verdict/v1"
COURT_SCHEMA = "archie-sidepus-disjoint-causal-court/v1"


def load(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != COURT_SCHEMA:
        raise ValueError(f"unsupported court receipt: {path}")
    body = dict(value)
    expected = body.pop("receipt_digest", None)
    if expected != digest_json(body):
        raise ValueError(f"court receipt digest mismatch: {path}")
    return value


def nested(value: Mapping[str, Any], *keys: str) -> float:
    current: Any = value
    for key in keys:
        if not isinstance(current, Mapping):
            raise KeyError(".".join(keys))
        current = current[key]
    return float(current)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pursuit", required=True)
    parser.add_argument("--sequential", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--minimum-pursuit-gain-bpb", type=float, default=0.0)
    parser.add_argument("--minimum-state-gain-vs-wrong", type=float, default=0.0)
    parser.add_argument("--minimum-compute-gain-vs-step1", type=float, default=0.0)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    pursuit_path = pathlib.Path(args.pursuit).expanduser().resolve()
    sequential_path = pathlib.Path(args.sequential).expanduser().resolve()
    pursuit = load(pursuit_path)
    sequential = load(sequential_path)

    if pursuit.get("plan_sha256") != sequential.get("plan_sha256"):
        raise SystemExit("pursuit and sequential controls were not evaluated on the same plan")
    if pursuit.get("split_binding") != sequential.get("split_binding"):
        raise SystemExit("pursuit and sequential controls have different split bindings")
    pursuit_bpb = nested(pursuit, "causal", "conditions", "correct", "bits_per_byte")
    sequential_bpb = nested(sequential, "causal", "conditions", "correct", "bits_per_byte")
    pursuit_advantage = sequential_bpb - pursuit_bpb
    state_gain = nested(pursuit, "causal", "effects", "gain_vs_wrong")
    compute_gain = nested(
        pursuit, "causal", "deliberation", "compute_adjusted_gain_vs_step1"
    )
    checks = {
        "pursuit_court_passed": bool(pursuit.get("passed")),
        "pursuit_beats_matched_sequential": pursuit_advantage >= args.minimum_pursuit_gain_bpb,
        "pursuit_uses_correct_state": state_gain >= args.minimum_state_gain_vs_wrong,
        "pursuit_compute_pays_for_itself": compute_gain >= args.minimum_compute_gain_vs_step1,
    }
    receipt: dict[str, Any] = {
        "schema": VERDICT_SCHEMA,
        "pursuit_receipt": str(pursuit_path),
        "pursuit_receipt_sha256": sha256_file(pursuit_path),
        "sequential_receipt": str(sequential_path),
        "sequential_receipt_sha256": sha256_file(sequential_path),
        "admission_plan_sha256": pursuit["plan_sha256"],
        "split_binding": pursuit.get("split_binding"),
        "effects": {
            "pursuit_bits_per_byte": pursuit_bpb,
            "sequential_bits_per_byte": sequential_bpb,
            "pursuit_gain_vs_sequential_bpb": pursuit_advantage,
            "pursuit_gain_vs_wrong_state_bpb": state_gain,
            "pursuit_compute_adjusted_gain_vs_step1_nats_per_token": compute_gain,
            "pursuit_halt_regret_nats_per_token": nested(
                pursuit, "causal", "deliberation", "halt_regret"
            ),
            "pursuit_retention_regression": nested(
                pursuit, "retention", "relative_regression"
            ),
            "sequential_retention_regression": nested(
                sequential, "retention", "relative_regression"
            ),
        },
        "thresholds": {
            "minimum_pursuit_gain_bpb": args.minimum_pursuit_gain_bpb,
            "minimum_state_gain_vs_wrong": args.minimum_state_gain_vs_wrong,
            "minimum_compute_gain_vs_step1": args.minimum_compute_gain_vs_step1,
        },
        "checks": checks,
        "passed": all(checks.values()),
        "promotion": "replication-required" if all(checks.values()) else "falsified",
        "claim_boundary": (
            "Passing shows this pursuit candidate beat a matched sequential control on one untouched admission split while using correct state and useful adaptive compute. "
            "Independent seeds and external task families remain mandatory before admission."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    output = pathlib.Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if args.strict and not receipt["passed"]:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
