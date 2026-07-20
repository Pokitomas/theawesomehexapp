#!/usr/bin/env python3
"""Fit fail-closed thresholds for auxiliary route veto heads.

Input rows are model evaluation records with a correct route label and numeric
head probabilities.  The route head remains primary.  Authority/context only
veto when a threshold can preserve the requested retention floor; activity and
compound only promote when their calibrated precision floor is met.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_rows(path: str) -> list[dict[str, Any]]:
    file = Path(path)
    if file.suffix == ".jsonl":
        return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
    value = json.loads(file.read_text())
    return value if isinstance(value, list) else value["rows"]


def choose_threshold(rows, score_key, truth_key, *, mode, precision_floor, retention_floor):
    candidates = sorted({0.0, 1.0, *[round(float(row[score_key]), 6) for row in rows]})
    best = None
    for threshold in candidates:
        tp = fp = tn = fn = 0
        retained = 0
        for row in rows:
            score = float(row[score_key])
            predicted = score >= threshold
            truth = bool(row[truth_key])
            if predicted and truth: tp += 1
            elif predicted and not truth: fp += 1
            elif not predicted and truth: fn += 1
            else: tn += 1
            route_correct = bool(row.get("route_correct", False))
            # An override is required for a positive auxiliary truth.  For a
            # negative truth, preserving the route head is correct only when
            # the route head itself was correct.
            final_correct = (predicted and truth) or ((not truth) and (not predicted) and route_correct)
            retained += int(final_correct)
        precision = tp / max(1, tp + fp)
        recall = tp / max(1, tp + fn)
        retention = retained / max(1, len(rows))
        eligible = precision >= precision_floor and retention >= retention_floor
        candidate = {
            "threshold": threshold, "precision": precision, "recall": recall,
            "retention": retention, "tp": tp, "fp": fp, "tn": tn, "fn": fn,
            "eligible": eligible,
        }
        if eligible and (best is None or (recall, precision, retention, threshold) > (best["recall"], best["precision"], best["retention"], best["threshold"])):
            best = candidate
    return best or {
        "threshold": 1.000001, "precision": 1.0, "recall": 0.0,
        "retention": sum(bool(r.get("route_correct", False)) for r in rows) / max(1, len(rows)),
        "eligible": False, "disabled": True,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--retention-floor", type=float, default=1.0)
    parser.add_argument("--veto-precision", type=float, default=0.995)
    parser.add_argument("--promotion-precision", type=float, default=0.98)
    args = parser.parse_args()
    rows = load_rows(args.data)
    if not rows:
        raise ValueError("no calibration rows")
    required = {
        "route_correct", "authority_deny_score", "authority_should_deny",
        "context_clarify_score", "context_should_clarify",
        "inactive_clause_score", "has_inactive_clause",
        "compound_score", "is_compound",
    }
    missing = required - set(rows[0])
    if missing:
        raise ValueError(f"missing required fields: {sorted(missing)}")

    calibration = {
        "authority_veto": choose_threshold(rows, "authority_deny_score", "authority_should_deny", mode="veto", precision_floor=args.veto_precision, retention_floor=args.retention_floor),
        "context_veto": choose_threshold(rows, "context_clarify_score", "context_should_clarify", mode="veto", precision_floor=args.veto_precision, retention_floor=args.retention_floor),
        "inactive_clause_gate": choose_threshold(rows, "inactive_clause_score", "has_inactive_clause", mode="promotion", precision_floor=args.promotion_precision, retention_floor=args.retention_floor),
        "compound_promotion": choose_threshold(rows, "compound_score", "is_compound", mode="promotion", precision_floor=args.promotion_precision, retention_floor=args.retention_floor),
    }
    body = {
        "schema": "archie-auxiliary-veto-calibration/v1",
        "examples": len(rows),
        "data_digest": digest(rows),
        "retention_floor": args.retention_floor,
        "calibration": calibration,
        "policy": {
            "route_head_primary": True,
            "auxiliary_heads_may_override_only_at_calibrated_threshold": True,
            "disabled_when_no_eligible_threshold": True,
        },
        "promotion": "not-admitted",
        "claim_boundary": "Calibration selects fail-closed thresholds on supplied development evidence; independent admission evaluation remains required.",
    }
    receipt = {**body, "receipt_digest": digest(body)}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
