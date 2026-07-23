#!/usr/bin/env python3
"""Strict authority boundary for Archie regenerative growth.

The growth engine can construct and train a larger descendant. This entrypoint
owns the harder decision: whether the evidence actually supports a capacity
experiment rather than another curriculum, objective, representation, or
measurement repair.
"""
from __future__ import annotations

import json
import math
import pathlib
from dataclasses import asdict
from typing import Any

from archie_hybrid_corpus import atomic_json, verify_u16_corpus
from archie_regenerative_growth import (
    DECISION_SCHEMA,
    decide_growth,
    digest_json,
    execute_cycle,
    load_model_payload,
    parser,
    sha256_file,
)

PLATEAU_FIELDS = (
    "plateau_relative_gain",
    "recent_relative_gain",
    "relative_improvement",
    "selected_relative_effect_vs_baseline",
)


def distinct_failed_attempts(evidence: dict[str, Any]) -> int:
    """Count interventions, not every failed gate emitted by one intervention."""
    explicit = evidence.get("failed_interventions")
    if isinstance(explicit, int) and not isinstance(explicit, bool) and explicit >= 0:
        return explicit
    attempts = evidence.get("attempts", evidence.get("interventions"))
    if not isinstance(attempts, list):
        return 0
    rejected: set[str] = set()
    for index, attempt in enumerate(attempts):
        if not isinstance(attempt, dict):
            continue
        if attempt.get("status") not in {"failed", "rejected"} and attempt.get("passed") is not False:
            continue
        identity = attempt.get("id") or attempt.get("kind") or attempt.get("intervention")
        if not isinstance(identity, str) or not identity.strip():
            identity = f"attempt-{index}"
        rejected.add(identity.strip())
    return len(rejected)


def explicit_plateau(evidence: dict[str, Any]) -> float | None:
    """Accept only a diagnosis-level plateau measurement, never arbitrary nested metrics."""
    for field in PLATEAU_FIELDS:
        value = evidence.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            resolved = float(value)
            return resolved if math.isfinite(resolved) else None
    return None


def normalize_diagnosis(evidence: dict[str, Any] | None, *, forced: bool) -> dict[str, Any]:
    if forced:
        return dict(evidence or {})
    if not isinstance(evidence, dict):
        raise ValueError("growth requires an explicit capacity-diagnosis JSON")
    failed = distinct_failed_attempts(evidence)
    plateau = explicit_plateau(evidence)
    if plateau is None:
        raise ValueError("capacity diagnosis must include an explicit finite plateau measurement")
    normalized = dict(evidence)
    normalized["failed_interventions"] = failed
    normalized["plateau_relative_gain"] = plateau
    return normalized


def verify_independent_corpora(args: Any) -> None:
    if not args.corpus or not args.eval_corpus:
        return
    train = verify_u16_corpus(pathlib.Path(args.corpus).resolve())
    evaluation = verify_u16_corpus(pathlib.Path(args.eval_corpus).resolve())
    identities = {train["sha256"], evaluation["sha256"]}
    if len(identities) != 2:
        raise ValueError("growth evaluation corpus must be independent from training")
    if args.retention_corpus:
        retention = verify_u16_corpus(pathlib.Path(args.retention_corpus).resolve())
        if retention["sha256"] in identities:
            raise ValueError("retention corpus must differ from training and growth evaluation")


def main() -> None:
    args = parser().parse_args()
    if args.requested_parameter_multiplier <= 1.0:
        raise SystemExit("requested parameter multiplier must exceed one")
    if args.max_parameter_multiplier < args.requested_parameter_multiplier:
        raise SystemExit("maximum parameter multiplier is below the requested multiplier")
    if args.minimum_failed_interventions < 1:
        raise SystemExit("minimum failed interventions must be positive")
    if args.probation_steps < 1 or args.unfreeze_steps < 0:
        raise SystemExit("probation steps must be positive and unfreeze steps nonnegative")
    if args.eval_batches < 1 or args.sequence_length < 2:
        raise SystemExit("evaluation batches and sequence length must be positive")

    parent_path = pathlib.Path(args.parent_model).resolve()
    parent_payload = load_model_payload(parent_path)
    raw_evidence = (
        json.loads(pathlib.Path(args.evidence_json).read_text(encoding="utf-8"))
        if args.evidence_json else None
    )
    evidence = normalize_diagnosis(raw_evidence, forced=args.force_growth)
    decision = decide_growth(
        parent_payload,
        evidence,
        requested_multiplier=args.requested_parameter_multiplier,
        max_parameter_multiplier=args.max_parameter_multiplier,
        minimum_failed_interventions=args.minimum_failed_interventions,
        plateau_threshold=args.plateau_threshold,
        force=args.force_growth,
    )
    decision_payload = {
        "schema": DECISION_SCHEMA,
        "authority": "archie-regenerative-governor/v1",
        "parent_model_sha256": sha256_file(parent_path),
        "normalized_diagnosis": evidence,
        "decision": asdict(decision),
        "boundary": (
            "Approval authorizes one bounded descendant experiment, not promotion. "
            "Distinct failed interventions and an explicit plateau are required so one "
            "bad run cannot manufacture a capacity-ceiling diagnosis from failed gates."
        ),
    }
    decision_payload["receipt_digest"] = digest_json(decision_payload)
    state = pathlib.Path(args.state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True)
    atomic_json(state / "growth-decision.json", decision_payload)

    if args.plan_only or not decision.approved:
        print(json.dumps(decision_payload, indent=2, sort_keys=True))
        return
    if not args.corpus or not args.eval_corpus:
        raise SystemExit("approved execution requires --corpus and --eval-corpus")
    verify_independent_corpora(args)
    if not args.birth_seed:
        args.birth_seed = [20260731, 20260801, 20260802]
    receipt = execute_cycle(args, decision)
    receipt["governor_decision_digest"] = decision_payload["receipt_digest"]
    receipt["receipt_digest"] = digest_json({key: value for key, value in receipt.items() if key != "receipt_digest"})
    atomic_json(state / "regenerative-cycle-receipt.json", receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
