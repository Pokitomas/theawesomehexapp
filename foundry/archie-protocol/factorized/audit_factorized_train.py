#!/usr/bin/env python3
"""Train and evaluate an audit-backed sparse factorized Archie controller.

Candidate selection is restricted to generated development data and a
hash-stratified holdout from the exact 925-row governed route corpus. The frozen
429-case challenge and the three exact legacy suites are opened only after the
training repetition, fusion weight, and temperature have been fixed.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from scipy.special import logsumexp

import factorized_controller as fc


AUDIT_CORPUS_SHA256 = "38d9df9c6f59d37c669cc3c3385172d2503995f5dc31e665d70941eb62ef8c57"
FROZEN_CHALLENGE_SHA256 = "3d053ee28c346e712a4e422a73cc8154f492db13947a129581084857a0ad101f"
LEGACY = {
    "router-v2-original-heldout": {
        "rows": 498,
        "sha256": "188d67330955a67bdb24a1bb096f2910eaa13a268b48dde77216cdd4f8be40f5",
    },
    "router-real-v2-heldout": {
        "rows": 60,
        "sha256": "72c0d30af384c42c54e244c6466f1ed710a1f58b157ed26cceb65f9d91068f64",
    },
    "router-real-v3-final": {
        "rows": 48,
        "sha256": "cb9131eaa0888d14a8e68f83e0486221b9b3dc5bf5b31a0df1a1f016433594dd",
    },
}
AUDIT_REPEATS = (0, 1, 2, 4)
STRUCTURAL_SHARES = (0.15, 0.30, 0.40, 0.4777777777777778, 0.55)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest_json(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def harmonic(a: float, b: float) -> float:
    return 0.0 if a <= 0.0 or b <= 0.0 else 2.0 * a * b / (a + b)


def explode_route_examples(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        expected = row["expected"]
        if expected["authority"] != "allow" or expected["context"] != "ready":
            continue
        if expected["route"] == "compound":
            clauses = [c for c in fc.split_clauses(row["request"]) if not fc.is_negated_clause(c)]
            for clause, route in zip(clauses, expected["outcomes"]):
                if route in fc.ROUTES and route != "clarify":
                    clone = dict(row)
                    clone["request"] = clause
                    clone["expected"] = {**expected, "route": route, "outcomes": [route]}
                    out.append(clone)
        elif expected["route"] in fc.ROUTES and expected["route"] != "clarify":
            out.append(row)
    return out


def audit_row(raw: dict[str, Any], index: int) -> dict[str, Any]:
    route = str(raw["route"])
    prompt = str(raw["prompt"])
    return {
        "id": f"audit-{index:04d}",
        "source_group": str(raw.get("source", "audit")),
        "category": "audit_route_only",
        "request": prompt,
        "attachments": "",
        "memory": "",
        "thread": "",
        "expected": {
            "route": route,
            "authority": "allow",
            "context": "ready",
            "outcomes": [] if route == "clarify" else [route],
            "reference_type": fc.reference_type(prompt),
        },
    }


def stratified_audit_split(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    skipped = collections.Counter()
    seen: set[str] = set()
    for row in rows:
        route = row["expected"]["route"]
        key = fc.norm_input(row)
        if key in seen:
            skipped["duplicate"] += 1
            continue
        seen.add(key)
        if route == "compound":
            skipped["compound_without_outcomes"] += 1
            continue
        if route not in fc.ROUTES:
            skipped["unsupported_route"] += 1
            continue
        grouped[route].append(row)

    train: list[dict[str, Any]] = []
    dev: list[dict[str, Any]] = []
    for route in sorted(grouped):
        ordered = sorted(
            grouped[route],
            key=lambda row: hashlib.sha256(fc.norm_input(row).encode("utf-8")).hexdigest(),
        )
        cut = min(len(ordered) - 1, max(1, int(math.floor(len(ordered) * 0.80))))
        train.extend(ordered[:cut])
        dev.extend(ordered[cut:])
    return train, dev, dict(skipped)


class WeightedController(fc.FactorizedController):
    def __init__(
        self,
        route_models: dict[str, Any],
        authority_model: Any,
        ref_model: Any,
        structural_share: float,
        route_temperature: float = 1.0,
    ) -> None:
        super().__init__(route_models, authority_model, ref_model, route_temperature, None)
        if not 0.0 <= structural_share <= 0.8:
            raise ValueError("structural_share outside bounded search")
        learned = 1.0 - structural_share
        ratio = np.array([16.0, 16.0, 15.0], dtype=float)
        ratio /= ratio.sum()
        self.fusion_weights = {
            "char_ngram_logistic": float(learned * ratio[0]),
            "word_ngram_logistic": float(learned * ratio[1]),
            "compact_svd_semantic": float(learned * ratio[2]),
            "structural_lexicon": float(structural_share),
        }

    def route_distribution(self, texts: list[str]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        parts: dict[str, np.ndarray] = {}
        request_features = [f"[REQ] {text}" for text in texts]
        for name, model in self.route_models.items():
            parts[name] = fc.class_proba_aligned(model, request_features, fc.ROUTES)
        structural = []
        for text in texts:
            scores = fc.structural_route_score(text)
            row = np.ones(len(fc.ROUTES), dtype=float) * 0.01
            for route, value in scores.items():
                row[fc.ROUTES.index(route)] += 1.8 * value
            row[fc.ROUTES.index("clarify")] += 0.02
            row /= row.sum()
            structural.append(row)
        parts["structural_lexicon"] = np.vstack(structural)

        logp = np.zeros_like(next(iter(parts.values())))
        total = 0.0
        for name, probabilities in parts.items():
            weight = self.fusion_weights[name]
            total += weight
            logp += weight * np.log(np.clip(probabilities, 1e-12, 1.0))
        logp /= total
        logp /= max(0.05, self.route_temperature)
        logp -= logsumexp(logp, axis=1, keepdims=True)
        return np.exp(logp), parts


def train_route_models(rows: list[dict[str, Any]], seed: int) -> dict[str, Any]:
    models = fc.make_route_models(seed)
    features = [fc.features_for_request(row, False) for row in rows]
    labels = [row["expected"]["route"] for row in rows]
    observed = set(labels)
    required = set(fc.ROUTES) - {"clarify"}
    if not required.issubset(observed) or not observed.issubset(set(fc.ROUTES)):
        raise SystemExit(f"route training class coverage mismatch: {sorted(observed)}")
    for model in models.values():
        model.fit(features, labels)
    return models


def direct_route_metrics(controller: WeightedController, rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"examples": 0, "correct": 0, "accuracy": None, "nll": None}
    probabilities, _ = controller.route_distribution([row["request"] for row in rows])
    expected = np.array([fc.ROUTES.index(row["expected"]["route"]) for row in rows])
    predicted = probabilities.argmax(axis=1)
    return {
        "examples": len(rows),
        "correct": int((predicted == expected).sum()),
        "accuracy": float((predicted == expected).mean()),
        "nll": float(-np.log(probabilities[np.arange(len(rows)), expected] + 1e-12).mean()),
    }


def fit_temperature(controller: WeightedController, rows: list[dict[str, Any]]) -> float:
    texts = [row["request"] for row in rows]
    expected = np.array([fc.ROUTES.index(row["expected"]["route"]) for row in rows])
    original = controller.route_temperature
    best = (float("inf"), 1.0)
    for temperature in np.linspace(0.55, 1.8, 26):
        controller.route_temperature = float(temperature)
        probabilities, _ = controller.route_distribution(texts)
        nll = float(-np.log(probabilities[np.arange(len(rows)), expected] + 1e-12).mean())
        if nll < best[0]:
            best = (nll, float(temperature))
    controller.route_temperature = original
    return best[1]


def load_legacy(path: Path, expected: dict[str, Any]) -> list[dict[str, Any]]:
    if sha256_file(path) != expected["sha256"]:
        raise SystemExit(f"legacy digest mismatch: {path.name}")
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if len(rows) != expected["rows"]:
        raise SystemExit(f"legacy row-count mismatch: {path.name}")
    return rows


def evaluate_legacy(controller: WeightedController, rows: list[dict[str, Any]]) -> dict[str, Any]:
    actual_correct = 0
    semantic_correct = 0
    errors = []
    texts = [str(row["text"]) for row in rows]
    probabilities, _ = controller.route_distribution(texts)
    direct = [fc.ROUTES[int(index)] for index in probabilities.argmax(axis=1)]
    for row, semantic_route in zip(rows, direct):
        request = str(row["text"])
        expected = str(row["expected"])
        candidate = {
            "request": request,
            "attachments": "",
            "memory": "",
            "thread": "",
        }
        prediction = controller.predict_one(candidate)
        actual_correct += int(prediction.route == expected)
        semantic_correct += int(semantic_route == expected)
        if prediction.route != expected and len(errors) < 25:
            errors.append({
                "id": row.get("id"),
                "text": request,
                "expected": expected,
                "actual": prediction.route,
                "direct_semantic": semantic_route,
                "decision_source": prediction.decision_source,
            })
    total = len(rows)
    return {
        "examples": total,
        "controller_route_correct": actual_correct,
        "controller_route_accuracy": actual_correct / total,
        "direct_semantic_correct": semantic_correct,
        "direct_semantic_accuracy": semantic_correct / total,
        "errors_sample": errors,
    }


def compact_full(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "errors"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-corpus", required=True)
    parser.add_argument("--frozen-challenge", required=True)
    parser.add_argument("--legacy-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=91017)
    args = parser.parse_args()

    audit_path = Path(args.audit_corpus)
    challenge_path = Path(args.frozen_challenge)
    legacy_dir = Path(args.legacy_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if sha256_file(audit_path) != AUDIT_CORPUS_SHA256:
        raise SystemExit("exact 925-row audit corpus digest mismatch")
    if sha256_file(challenge_path) != FROZEN_CHALLENGE_SHA256:
        raise SystemExit("frozen 429-case challenge digest mismatch")

    raw_audit = json.loads(audit_path.read_text())
    if len(raw_audit) != 925:
        raise SystemExit("audit corpus must contain exactly 925 rows")
    audit_rows = [audit_row(row, index) for index, row in enumerate(raw_audit)]
    audit_train, audit_dev, audit_skipped = stratified_audit_split(audit_rows)

    train_raw = fc.generate_dataset(
        args.seed + 1,
        "train",
        n_single=800,
        n_ref_each=80,
        n_compound=160,
        n_authority_each=80,
        n_ambiguous=80,
    )
    dev_raw = fc.generate_dataset(
        args.seed + 2,
        "dev",
        n_single=240,
        n_ref_each=32,
        n_compound=72,
        n_authority_each=32,
        n_ambiguous=32,
    )
    seen: set[str] = set()
    train, dropped_train = fc.unique_rows(train_raw, seen)
    dev, dropped_dev = fc.unique_rows(dev_raw, seen)
    route_train = explode_route_examples(train)
    route_dev = explode_route_examples(dev)

    challenge = json.loads(challenge_path.read_text())
    if len(challenge) != 429:
        raise SystemExit("frozen challenge must contain exactly 429 rows")
    challenge_keys = {fc.norm_input(row) for row in challenge}
    training_keys = {fc.norm_input(row) for row in train + dev + audit_train + audit_dev}
    overlap = sorted(challenge_keys & training_keys)
    if overlap:
        raise SystemExit(f"frozen challenge exact overlap detected: {overlap[:3]}")

    authority_model = fc.make_pipeline(
        fc.HashingVectorizer(
            analyzer="char_wb",
            ngram_range=(3, 5),
            n_features=4096,
            alternate_sign=False,
            norm="l2",
        ),
        fc.SGDClassifier(
            loss="log_loss",
            alpha=2e-5,
            max_iter=35,
            tol=1e-4,
            random_state=args.seed + 9,
            class_weight="balanced",
        ),
    )
    authority_model.fit(
        [fc.features_for_request(row, False) for row in train],
        [row["expected"]["authority"] for row in train],
    )
    ref_model = fc.make_pipeline(
        fc.HashingVectorizer(
            analyzer="word",
            ngram_range=(1, 3),
            n_features=4096,
            alternate_sign=False,
            norm="l2",
        ),
        fc.SGDClassifier(
            loss="log_loss",
            alpha=2e-5,
            max_iter=35,
            tol=1e-4,
            random_state=args.seed + 10,
            class_weight="balanced",
        ),
    )
    ref_model.fit(
        [fc.features_for_request(row, False) for row in train],
        [row["expected"]["reference_type"] for row in train],
    )

    selection_trace = []
    trained: dict[int, dict[str, Any]] = {}
    best_key: tuple[float, float, float, float] | None = None
    best_spec: tuple[int, float] | None = None
    for repeat in AUDIT_REPEATS:
        mixed = route_train + audit_train * repeat
        models = train_route_models(mixed, args.seed + repeat * 101)
        trained[repeat] = models
        for structural_share in STRUCTURAL_SHARES:
            controller = WeightedController(models, authority_model, ref_model, structural_share)
            generated = direct_route_metrics(controller, route_dev)
            authored = direct_route_metrics(controller, audit_dev)
            score = harmonic(float(generated["accuracy"]), float(authored["accuracy"]))
            key = (
                round(min(float(generated["accuracy"]), float(authored["accuracy"])), 12),
                round(score, 12),
                round(float(generated["accuracy"]), 12),
                -float(structural_share),
            )
            row = {
                "audit_repeat": repeat,
                "structural_share": structural_share,
                "generated_route": generated,
                "audit_holdout_route": authored,
                "selection_harmonic": score,
                "selection_key": list(key),
            }
            selection_trace.append(row)
            if best_key is None or key > best_key:
                best_key = key
                best_spec = (repeat, structural_share)

    if best_spec is None:
        raise SystemExit("no factorized candidate selected")
    selected_repeat, selected_structural = best_spec
    selected = WeightedController(
        trained[selected_repeat],
        authority_model,
        ref_model,
        selected_structural,
    )
    selected.route_temperature = fit_temperature(selected, route_dev + audit_dev)

    baseline = WeightedController(
        trained[0],
        authority_model,
        ref_model,
        0.4777777777777778,
    )
    baseline.route_temperature = fit_temperature(baseline, route_dev)

    baseline_dev = fc.evaluate(baseline, dev, "generated_development_baseline")
    selected_dev = fc.evaluate(selected, dev, "generated_development_selected")
    selected_audit = direct_route_metrics(selected, audit_dev)

    baseline_blind = fc.evaluate(baseline, challenge, "frozen_blind_429_baseline")
    selected_blind = fc.evaluate(selected, challenge, "frozen_blind_429_selected")
    selected_semantic = fc.ablation_semantic_only(
        selected.route_models,
        challenge,
        None,
        selected.route_temperature,
    )
    structural_blind = fc.structural_only(challenge)

    legacy_results: dict[str, Any] = {"baseline": {}, "selected": {}}
    legacy_evidence = {}
    for name, expected in LEGACY.items():
        path = legacy_dir / f"{name}.jsonl"
        rows = load_legacy(path, expected)
        legacy_evidence[name] = {
            "sha256": expected["sha256"],
            "rows": len(rows),
        }
        legacy_results["baseline"][name] = evaluate_legacy(baseline, rows)
        legacy_results["selected"][name] = evaluate_legacy(selected, rows)

    model_path = out / "factorized-audit-selected.joblib"
    joblib.dump(
        {
            "schema": "archie-factorized-audit-selected/v1",
            "routes": fc.ROUTES,
            "route_models": selected.route_models,
            "authority_model": selected.authority_model,
            "ref_model": selected.ref_model,
            "fusion_weights": selected.fusion_weights,
            "route_temperature": selected.route_temperature,
            "audit_repeat": selected_repeat,
        },
        model_path,
        compress=("gzip", 3),
    )

    receipt = {
        "schema": "archie-factorized-audit-experiment/v1",
        "seed": args.seed,
        "promotion": "not-admitted",
        "production_changed": False,
        "data": {
            "audit_corpus_sha256": AUDIT_CORPUS_SHA256,
            "audit_rows": len(raw_audit),
            "audit_train_route_rows": len(audit_train),
            "audit_selection_route_rows": len(audit_dev),
            "audit_skipped": audit_skipped,
            "audit_train_digest": digest_json([fc.norm_input(row) for row in audit_train]),
            "audit_selection_digest": digest_json([fc.norm_input(row) for row in audit_dev]),
            "synthetic_train_rows": len(train),
            "synthetic_development_rows": len(dev),
            "synthetic_route_train_rows": len(route_train),
            "synthetic_route_development_rows": len(route_dev),
            "synthetic_exact_drops": {"train": dropped_train, "development": dropped_dev},
            "frozen_challenge_sha256": FROZEN_CHALLENGE_SHA256,
            "frozen_challenge_rows": len(challenge),
            "frozen_exact_overlap": 0,
            "legacy": legacy_evidence,
        },
        "selection_contract": {
            "audit_repeats": list(AUDIT_REPEATS),
            "structural_shares": list(STRUCTURAL_SHARES),
            "primary": "maximize the lower of generated route accuracy and audit-heldout route accuracy",
            "secondary": "maximize their harmonic mean, then generated route accuracy, then prefer less structural weight",
            "frozen_evidence_used_for_selection": False,
            "authority_and_reference_training": "synthetic-only; audit route labels cannot alter authority/context factors",
            "compound_audit_rows": "excluded because route-only corpus lacks ordered outcomes",
        },
        "selection_trace": selection_trace,
        "selected": {
            "audit_repeat": selected_repeat,
            "structural_share": selected_structural,
            "fusion_weights": selected.fusion_weights,
            "route_temperature": selected.route_temperature,
            "generated_development_full": compact_full(selected_dev),
            "audit_holdout_route": selected_audit,
            "frozen_blind_429_full": compact_full(selected_blind),
            "frozen_blind_semantic_only": selected_semantic,
            "exact_legacy": legacy_results["selected"],
        },
        "baseline": {
            "audit_repeat": 0,
            "structural_share": 0.4777777777777778,
            "fusion_weights": baseline.fusion_weights,
            "route_temperature": baseline.route_temperature,
            "generated_development_full": compact_full(baseline_dev),
            "frozen_blind_429_full": compact_full(baseline_blind),
            "exact_legacy": legacy_results["baseline"],
        },
        "structural_only_frozen_blind": compact_full(structural_blind),
        "model": {
            "path": model_path.name,
            "bytes": model_path.stat().st_size,
            "sha256": sha256_file(model_path),
        },
        "admission": {
            "status": "not-admitted",
            "reason": "This bounded experiment evaluates route learning, factorized authority/context behavior on frozen-429, and exact legacy route retention. It does not supply the complete 310-case runtime parity, resource, production packaging, and all protected admission receipts required for promotion.",
        },
    }
    receipt["receipt_digest"] = digest_json(receipt)
    receipt_path = out / "factorized-audit-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    comparison = {
        "schema": "archie-factorized-audit-comparison/v1",
        "selected_spec": {
            "audit_repeat": selected_repeat,
            "structural_share": selected_structural,
            "route_temperature": selected.route_temperature,
        },
        "baseline_blind_full": baseline_blind["accuracy"],
        "selected_blind_full": selected_blind["accuracy"],
        "selected_semantic_only_blind": selected_semantic["accuracy"],
        "structural_only_blind_full": structural_blind["accuracy"],
        "selected_legacy_controller_route": {
            name: result["controller_route_accuracy"]
            for name, result in legacy_results["selected"].items()
        },
        "selected_legacy_direct_semantic": {
            name: result["direct_semantic_accuracy"]
            for name, result in legacy_results["selected"].items()
        },
        "model_sha256": receipt["model"]["sha256"],
        "receipt_digest": receipt["receipt_digest"],
        "promotion": "not-admitted",
        "production_changed": False,
    }
    comparison["comparison_digest"] = digest_json(comparison)
    (out / "factorized-audit-comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    print(json.dumps(comparison, indent=2), flush=True)


if __name__ == "__main__":
    main()
