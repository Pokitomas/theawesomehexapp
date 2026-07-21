from __future__ import annotations

import pathlib
from typing import Any

from .core import (
    SCHEMA_EVALUATION,
    SCHEMA_PREFERENCE_TRAINING,
    SCHEMA_REPRODUCTION,
    SCHEMA_TRAINING,
    metric_delta,
    read_json,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
)


def compare_reproduction(
    first_training: dict[str, Any],
    second_training: dict[str, Any],
    first_evaluation: dict[str, Any],
    second_evaluation: dict[str, Any],
    *,
    metric_tolerance: float,
) -> dict[str, Any]:
    valid_training = {SCHEMA_TRAINING, SCHEMA_PREFERENCE_TRAINING}
    if first_training.get("schema") not in valid_training or second_training.get("schema") not in valid_training:
        raise ValueError("Unsupported training receipt schema")
    if first_training.get("schema") != second_training.get("schema"):
        raise ValueError("Reproduction runs must use the same training method")
    if first_evaluation.get("schema") != SCHEMA_EVALUATION or second_evaluation.get("schema") != SCHEMA_EVALUATION:
        raise ValueError("Reproduction requires evaluation v2 receipts")
    first_dataset = first_training.get("dataset") or first_training.get("preference_dataset")
    second_dataset = second_training.get("dataset") or second_training.get("preference_dataset")
    same_inputs = stable_json(first_dataset) == stable_json(second_dataset)
    same_checkpoint = (
        first_training.get("student_checkpoint", {}).get("digest")
        == second_training.get("student_checkpoint", {}).get("digest")
    )
    first_metrics = first_evaluation.get("metrics") or {}
    second_metrics = second_evaluation.get("metrics") or {}
    delta = metric_delta(second_metrics, first_metrics)
    metric_match = abs(float(delta.get("combined", 0.0))) <= metric_tolerance
    both_non_regressing = all(
        (receipt.get("comparison") or {}).get("non_regression_passed") is True
        for receipt in (first_evaluation, second_evaluation)
    )
    independent_receipts = first_training.get("receipt_digest") != second_training.get("receipt_digest")
    passed = same_inputs and same_checkpoint and metric_match and both_non_regressing and independent_receipts
    return {
        "same_inputs": same_inputs,
        "same_checkpoint": same_checkpoint,
        "metric_delta": delta,
        "metric_tolerance": metric_tolerance,
        "metric_match": metric_match,
        "both_non_regressing": both_non_regressing,
        "independent_receipts": independent_receipts,
        "passed": passed,
    }


def configure_parser(parser: Any) -> None:
    parser.add_argument("--training", action="append", required=True)
    parser.add_argument("--evaluation", action="append", required=True)
    parser.add_argument("--metric-tolerance", type=float, default=0.02)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    if len(args.training) != 2 or len(args.evaluation) != 2:
        raise SystemExit("Independent reproduction requires exactly two training and two evaluation receipts")
    training_paths = [pathlib.Path(item).resolve() for item in args.training]
    evaluation_paths = [pathlib.Path(item).resolve() for item in args.evaluation]
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    training = [read_json(path) for path in training_paths]
    evaluations = [read_json(path) for path in evaluation_paths]
    result = compare_reproduction(
        training[0], training[1], evaluations[0], evaluations[1],
        metric_tolerance=float(args.metric_tolerance),
    )
    receipt: dict[str, Any] = {
        "schema": SCHEMA_REPRODUCTION,
        "method": "same-input-independent-run-evaluation-reproduction/v1",
        "training_receipts": [
            {"path": str(path), "sha256": sha256_file(path), "receipt_digest": value.get("receipt_digest")}
            for path, value in zip(training_paths, training, strict=True)
        ],
        "evaluation_receipts": [
            {"path": str(path), "sha256": sha256_file(path), "receipt_digest": value.get("receipt_digest")}
            for path, value in zip(evaluation_paths, evaluations, strict=True)
        ],
        "result": result,
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output, receipt)
    return receipt
