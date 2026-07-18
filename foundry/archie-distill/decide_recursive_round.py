#!/usr/bin/env python3
"""Turn concrete held-out/quantized failures into one bounded next round.

This module never invents training data. It accepts evaluator receipts that bind
existing causal pair IDs, identifies regressions or quantization-specific losses,
and emits a priority set consumed by ``segment_causal_pairs.py``. No evaluator
failure means no recursive round.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from train import read_json, read_jsonl, sha256, stable  # type: ignore

EVALUATION_SCHEMA = "archie-segmented-distillation-evaluation/v1"
FAILURE_SCHEMA = "archie-quantization-failure-set/v1"
DECISION_SCHEMA = "archie-recursive-distillation-decision/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"


def verify_receipt(path: pathlib.Path, expected_schema: str) -> dict[str, Any]:
    value = read_json(path)
    if value.get("schema") != expected_schema:
        raise SystemExit(f"Unexpected receipt schema in {path}.")
    body = dict(value)
    claimed = body.pop("receipt_digest", None)
    if not claimed or hashlib.sha256(stable(body).encode("utf-8")).hexdigest() != claimed:
        raise SystemExit(f"Receipt integrity failed for {path}.")
    return value


def case_severity(case: dict[str, Any], *, quant_floor: float) -> tuple[float, list[str]]:
    reasons: list[str] = []
    base = case.get("base") or {}
    adapter = case.get("adapter") or {}
    quantized = case.get("quantized") or {}
    base_pass = bool(base.get("passed"))
    adapter_pass = bool(adapter.get("passed"))
    base_score = float(base.get("score", 0.0))
    adapter_score = float(adapter.get("score", 0.0))
    severity = 0.0
    if base_pass and not adapter_pass:
        severity = max(severity, 4.0)
        reasons.append("adapter-regression")
    elif not adapter_pass:
        severity = max(severity, 2.0)
        reasons.append("adapter-held-out-failure")
    if adapter_score < base_score:
        severity = max(severity, 3.0)
        reasons.append("adapter-score-regression")
    for quantization, result in sorted(quantized.items()):
        if not isinstance(result, dict):
            raise SystemExit(f"quantized.{quantization} must be an object.")
        passed = bool(result.get("passed"))
        retention = float(result.get("quality_retention", 0.0))
        if adapter_pass and not passed:
            severity = max(severity, 4.0)
            reasons.append(f"{quantization}-lost-adapter-success")
        elif not passed:
            severity = max(severity, 2.5)
            reasons.append(f"{quantization}-failure")
        if retention < quant_floor:
            gap = min(1.0, max(0.0, quant_floor - retention))
            severity = max(severity, 1.0 + 3.0 * gap)
            reasons.append(f"{quantization}-retention-below-floor")
    return min(4.0, severity), sorted(set(reasons))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluation", required=True)
    parser.add_argument("--pair-data", action="append", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-rounds", type=int, default=3)
    parser.add_argument("--quant-retention-floor", type=float, default=0.97)
    args = parser.parse_args()

    evaluation_path = pathlib.Path(args.evaluation).resolve()
    evaluation = verify_receipt(evaluation_path, EVALUATION_SCHEMA)
    if evaluation.get("method") != METHOD:
        raise SystemExit("Evaluation method mismatch.")
    current_round = int(evaluation.get("round", -1))
    if current_round < 0:
        raise SystemExit("Evaluation round must be nonnegative.")
    if args.max_rounds < 1:
        raise SystemExit("max-rounds must be positive.")
    if not 0 < args.quant_retention_floor <= 1:
        raise SystemExit("quant-retention-floor must be in (0,1].")

    pair_paths = [pathlib.Path(item).resolve() for item in args.pair_data]
    rows = []
    for path in pair_paths:
        rows.extend(read_jsonl(path, required=True))
    known = {str(row.get("pair_id")): str(row.get("pair_digest")) for row in rows}
    if len(known) != len(rows):
        raise SystemExit("Pair IDs must be unique across pair-data inputs.")

    failures = []
    for index, case in enumerate(evaluation.get("cases", [])):
        if not isinstance(case, dict):
            raise SystemExit(f"cases[{index}] must be an object.")
        pair_id = str(case.get("pair_id") or "").strip()
        pair_digest = str(case.get("pair_digest") or "").strip()
        evaluator_digest = str(case.get("evaluator_digest") or "").strip()
        if pair_id not in known or known[pair_id] != pair_digest:
            raise SystemExit(f"cases[{index}] does not bind an existing causal pair.")
        if len(evaluator_digest) != 64:
            raise SystemExit(f"cases[{index}].evaluator_digest must be a SHA-256 digest.")
        severity, reasons = case_severity(case, quant_floor=args.quant_retention_floor)
        if severity > 0:
            failures.append({
                "pair_id": pair_id,
                "pair_digest": pair_digest,
                "severity": severity,
                "reasons": reasons,
                "evaluator_digest": evaluator_digest,
            })
    failures.sort(key=lambda item: (-item["severity"], item["pair_id"]))

    next_round = current_round + 1
    bounded = next_round < args.max_rounds
    continue_training = bool(failures) and bounded
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)

    failure_receipt = None
    if continue_training:
        failure_body = {
            "schema": FAILURE_SCHEMA,
            "method": METHOD,
            "source_evaluation_digest": evaluation.get("receipt_digest"),
            "source_round": current_round,
            "next_round": next_round,
            "failures": failures,
            "policy": {
                "existing_pair_ids_only": True,
                "evaluator_failure_required": True,
                "quant_retention_floor": args.quant_retention_floor,
                "maximum_severity": 4,
            },
            "claim_boundary": "This set prioritizes existing verified pairs that failed a bound evaluator. It does not create synthetic evidence or prove a future training gain.",
        }
        failure_receipt = {**failure_body, "receipt_digest": hashlib.sha256(stable(failure_body).encode("utf-8")).hexdigest()}
        (output / "quantization-failures.json").write_text(json.dumps(failure_receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    decision_body = {
        "schema": DECISION_SCHEMA,
        "method": METHOD,
        "evaluation": {"path": str(evaluation_path), "sha256": sha256(evaluation_path), "receipt_digest": evaluation.get("receipt_digest")},
        "pair_inputs": [{"path": str(path), "sha256": sha256(path)} for path in pair_paths],
        "current_round": current_round,
        "next_round": next_round if continue_training else None,
        "max_rounds": args.max_rounds,
        "failure_count": len(failures),
        "continue_training": continue_training,
        "stop_reason": None if continue_training else ("no-concrete-evaluator-failures" if not failures else "maximum-rounds-reached"),
        "failure_set_digest": failure_receipt.get("receipt_digest") if failure_receipt else None,
        "promotion": "not-admitted",
        "claim_boundary": "Recursive training is authorized only by concrete bound evaluator failures and remains capped. This decision does not claim that another round will improve capability or quantization.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    decision = {**decision_body, "receipt_digest": hashlib.sha256(stable(decision_body).encode("utf-8")).hexdigest()}
    (output / "round-decision.json").write_text(json.dumps(decision, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(decision, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
