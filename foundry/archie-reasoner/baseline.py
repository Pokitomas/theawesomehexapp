#!/usr/bin/env python3
"""Train the frozen-prompt-safe TF-IDF + LogisticRegression Archie route baseline."""
from __future__ import annotations

import argparse
import json
import math
import os
import random
from pathlib import Path
from typing import Any, Sequence

from archie_reasoner import (
    AUTHORITY_LABELS,
    CONTEXT_LABELS,
    DEFAULT_TRANSFORMS,
    ROUTES,
    authority_from_row,
    context_state_from_row,
    filter_frozen_rows,
    frozen_prompt_set,
    prompt_from_row,
    read_records,
    route_from_row,
    route_metrics,
    sha256_file,
    sha256_json,
    source_text,
    stratified_split,
    transform_from_row,
    write_receipt,
)

EVAL_FILENAMES = (
    "router-v2-original-heldout.jsonl",
    "router-real-v2-heldout.jsonl",
    "router-real-v3-final.jsonl",
)


def dependencies():
    try:
        import joblib  # type: ignore
        import numpy as np  # type: ignore
        from sklearn.compose import ColumnTransformer  # noqa: F401
        from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore
        from sklearn.linear_model import LogisticRegression  # type: ignore
        from sklearn.pipeline import FeatureUnion, Pipeline  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "The baseline requires scikit-learn, numpy, and joblib from requirements.txt"
        ) from exc
    return joblib, np, TfidfVectorizer, LogisticRegression, FeatureUnion, Pipeline



class ConstantClassifier:
    """Joblib-safe fallback when a training target has one observed class."""

    def __init__(self, label: str):
        self.label = str(label)
        self.classes_ = [self.label]

    def fit(self, texts: Sequence[str], labels: Sequence[str]):
        return self

    def predict(self, texts: Sequence[str]):
        import numpy as np  # type: ignore
        return np.asarray([self.label] * len(texts), dtype=object)

    def predict_proba(self, texts: Sequence[str]):
        import numpy as np  # type: ignore
        return np.ones((len(texts), 1), dtype=float)


def fit_or_constant(
    texts: Sequence[str],
    labels: Sequence[str],
    *,
    max_features: int,
    c_value: float,
    max_iter: int,
    seed: int,
):
    unique = sorted(set(labels))
    if len(unique) == 1:
        return ConstantClassifier(unique[0])
    model = make_pipeline(max_features, c_value, max_iter, seed)
    model.fit(texts, labels)
    return model

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True)
    parser.add_argument("--evals")
    parser.add_argument("--suite")
    parser.add_argument("--frozen", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--dev-fraction", type=float, default=0.10)
    parser.add_argument("--max-features", type=int, default=16000)
    parser.add_argument("--c", type=float, default=4.0)
    parser.add_argument("--max-iter", type=int, default=1000)
    return parser.parse_args()


def evaluation_paths(args: argparse.Namespace) -> list[Path]:
    paths: list[Path] = []
    if args.evals:
        base = Path(args.evals)
        paths.extend(base / name for name in EVAL_FILENAMES if (base / name).exists())
    if args.suite and Path(args.suite).exists():
        paths.append(Path(args.suite))
    paths.extend(Path(item) for item in args.frozen if Path(item).exists())
    return paths


def make_pipeline(max_features: int, c_value: float, max_iter: int, seed: int):
    _, _, TfidfVectorizer, LogisticRegression, FeatureUnion, Pipeline = dependencies()
    word_limit = max(1000, max_features // 2)
    char_limit = max(1000, max_features - word_limit)
    features = FeatureUnion(
        [
            (
                "word",
                TfidfVectorizer(
                    analyzer="word",
                    ngram_range=(1, 2),
                    min_df=2,
                    max_features=word_limit,
                    sublinear_tf=True,
                    strip_accents="unicode",
                ),
            ),
            (
                "char",
                TfidfVectorizer(
                    analyzer="char_wb",
                    ngram_range=(3, 5),
                    min_df=2,
                    max_features=char_limit,
                    sublinear_tf=True,
                    strip_accents="unicode",
                ),
            ),
        ]
    )
    classifier = LogisticRegression(
        C=c_value,
        max_iter=max_iter,
        solver="lbfgs",
        class_weight="balanced",
        random_state=seed,
    )
    return Pipeline([("features", features), ("classifier", classifier)])


def forced_route(row: dict[str, Any]) -> str:
    route = route_from_row(row)
    authority = authority_from_row(row)
    context = context_state_from_row(row, route)
    return "clarify" if authority == "deny" or context != "ready" else route


def evaluate_classifier(model: Any, rows: Sequence[dict[str, Any]], np: Any) -> dict[str, Any]:
    if not rows:
        return {"examples": 0, "accuracy": None}
    texts = [source_text(row) for row in rows]
    expected = [forced_route(row) for row in rows]
    predicted = [str(item) for item in model.predict(texts)]
    probability = model.predict_proba(texts)
    classes = list(model.classes_)
    class_index = {label: index for index, label in enumerate(classes)}
    losses = []
    errors = []
    for index, (actual, wanted) in enumerate(zip(predicted, expected)):
        probability_value = float(probability[index, class_index[wanted]]) if wanted in class_index else 1e-12
        losses.append(-math.log(max(1e-12, probability_value)))
        if actual != wanted and len(errors) < 32:
            errors.append(
                {
                    "id": rows[index].get("id"),
                    "prompt": prompt_from_row(rows[index])[:240],
                    "expected": wanted,
                    "actual": actual,
                    "confidence": float(np.max(probability[index])),
                }
            )
    result = route_metrics(predicted, expected)
    result["nll"] = sum(losses) / max(1, len(losses))
    result["errors"] = errors
    return result


def evaluate_binary(model: Any, rows: Sequence[dict[str, Any]], target_name: str) -> dict[str, Any]:
    if not rows:
        return {"examples": 0, "accuracy": None}
    texts = [source_text(row) for row in rows]
    if target_name == "authority":
        expected = [authority_from_row(row) for row in rows]
    elif target_name == "context":
        expected = [context_state_from_row(row, route_from_row(row)) for row in rows]
    else:
        expected = [transform_from_row(row) for row in rows]
    predicted = [str(item) for item in model.predict(texts)]
    correct = sum(actual == wanted for actual, wanted in zip(predicted, expected))
    return {"examples": len(rows), "accuracy": correct / max(1, len(rows))}


def main() -> int:
    args = parse_args()
    joblib, np, *_ = dependencies()
    random.seed(args.seed)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    frozen_paths = evaluation_paths(args)
    frozen = frozen_prompt_set(frozen_paths)
    all_rows = read_records(args.data)
    filtered, removed = filter_frozen_rows(all_rows, frozen)
    train_rows, dev_rows = stratified_split(filtered, args.dev_fraction, args.seed)
    if not train_rows or not dev_rows:
        raise RuntimeError("baseline needs non-empty train and development splits")

    train_text = [source_text(row) for row in train_rows]
    route_model = fit_or_constant(
        train_text,
        [forced_route(row) for row in train_rows],
        max_features=args.max_features,
        c_value=args.c,
        max_iter=args.max_iter,
        seed=args.seed,
    )
    authority_model = fit_or_constant(
        train_text,
        [authority_from_row(row) for row in train_rows],
        max_features=max(4000, args.max_features // 2),
        c_value=args.c,
        max_iter=args.max_iter,
        seed=args.seed + 1,
    )
    context_model = fit_or_constant(
        train_text,
        [context_state_from_row(row, route_from_row(row)) for row in train_rows],
        max_features=max(4000, args.max_features // 2),
        c_value=args.c,
        max_iter=args.max_iter,
        seed=args.seed + 2,
    )
    transform_model = fit_or_constant(
        train_text,
        [transform_from_row(row) for row in train_rows],
        max_features=max(4000, args.max_features // 2),
        c_value=args.c,
        max_iter=args.max_iter,
        seed=args.seed + 3,
    )

    bundle = {
        "schema": "archie-reasoner-tfidf-baseline/v1",
        "route": route_model,
        "authority": authority_model,
        "context": context_model,
        "transform": transform_model,
        "routes": ROUTES,
        "authority_labels": AUTHORITY_LABELS,
        "context_labels": CONTEXT_LABELS,
        "promotion": "not-admitted",
    }
    model_path = output / "baseline.joblib"
    joblib.dump(bundle, model_path, compress=3)

    frozen_results: dict[str, Any] = {}
    for path in frozen_paths:
        rows = read_records(path)
        frozen_results[path.name] = {
            "route": evaluate_classifier(route_model, rows, np),
            "authority": evaluate_binary(authority_model, rows, "authority"),
            "context": evaluate_binary(context_model, rows, "context"),
            "transform": evaluate_binary(transform_model, rows, "transform"),
        }

    body = {
        "schema": "archie-reasoner-baseline-receipt/v1",
        "model": {
            "method": "word-char-tfidf-logistic-regression/v1",
            "max_features": args.max_features,
            "c": args.c,
            "max_iter": args.max_iter,
            "artifact": model_path.name,
            "artifact_sha256": sha256_file(model_path),
        },
        "data": {
            "input_rows": len(all_rows),
            "removed_frozen_rows": len(removed),
            "train_rows": len(train_rows),
            "development_rows": len(dev_rows),
            "train_digest": sha256_json(
                [
                    {
                        "source": source_text(row),
                        "route": forced_route(row),
                        "authority": authority_from_row(row),
                        "context": context_state_from_row(row, route_from_row(row)),
                        "transform": transform_from_row(row),
                    }
                    for row in train_rows
                ]
            ),
        },
        "evaluation": {
            "development": {
                "route": evaluate_classifier(route_model, dev_rows, np),
                "authority": evaluate_binary(authority_model, dev_rows, "authority"),
                "context": evaluate_binary(context_model, dev_rows, "context"),
                "transform": evaluate_binary(transform_model, dev_rows, "transform"),
            },
            "frozen": frozen_results,
        },
        "promotion": "not-admitted",
        "claim_boundary": (
            "Sparse lexical baseline for route/authority/context/transform classification only. "
            "It does not generate task graphs or response plans."
        ),
    }
    receipt = write_receipt(output / "baseline-receipt.json", body)
    print(
        json.dumps(
            {
                "ok": True,
                "artifact": str(model_path),
                "receipt": str(output / "baseline-receipt.json"),
                "development": receipt["evaluation"]["development"],
                "promotion": receipt["promotion"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
