#!/usr/bin/env python3
"""Final audit-expert and trained-compound follow-up for Archie.

The frozen challenge is not consulted until route-expert fusion, compound
threshold, and final refit rules are fixed from generated development and a
hash-stratified audit holdout. Because the frozen pack has been used by prior
experiments, this run remains research evidence and cannot by itself authorize
promotion.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from scipy.special import logsumexp

import factorized_controller as fc
import audit_factorized_train as aft


STRUCTURAL_SHARES = (0.30, 0.40, 0.4777777777777778, 0.55)
AUDIT_EXPERT_SHARES = (0.0, 0.05, 0.10, 0.20, 0.30)
COMPOUND_THRESHOLDS = tuple(float(x) for x in np.linspace(0.25, 0.80, 12))


def binary_audit_split(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = collections.defaultdict(list)
    seen = set()
    for row in rows:
        key = fc.norm_input(row)
        if key in seen:
            continue
        seen.add(key)
        grouped[int(row["expected"]["route"] == "compound")].append(row)
    train, dev = [], []
    for label in (0, 1):
        ordered = sorted(grouped[label], key=lambda row: hashlib.sha256(fc.norm_input(row).encode()).hexdigest())
        cut = min(len(ordered) - 1, max(1, int(math.floor(len(ordered) * 0.80))))
        train.extend(ordered[:cut])
        dev.extend(ordered[cut:])
    return train, dev


def make_audit_expert(seed: int) -> Any:
    return fc.make_pipeline(
        fc.HashingVectorizer(
            analyzer="char_wb", ngram_range=(3, 5), n_features=8192,
            alternate_sign=False, norm="l2",
        ),
        fc.SGDClassifier(
            loss="log_loss", alpha=1.5e-5, max_iter=50, tol=1e-4,
            random_state=seed, class_weight="balanced",
        ),
    )


def fit_audit_expert(rows: list[dict[str, Any]], seed: int) -> Any:
    model = make_audit_expert(seed)
    model.fit(
        [fc.features_for_request(row, False) for row in rows],
        [row["expected"]["route"] for row in rows],
    )
    return model


def make_compound_model(seed: int) -> Any:
    return fc.make_pipeline(
        fc.HashingVectorizer(
            analyzer="char_wb", ngram_range=(3, 6), n_features=8192,
            alternate_sign=False, norm="l2",
        ),
        fc.SGDClassifier(
            loss="log_loss", alpha=1.5e-5, max_iter=50, tol=1e-4,
            random_state=seed, class_weight="balanced",
        ),
    )


def fit_compound_model(rows: list[dict[str, Any]], seed: int) -> Any:
    model = make_compound_model(seed)
    model.fit(
        [fc.features_for_request(row, False) for row in rows],
        [int(row["expected"]["route"] == "compound") for row in rows],
    )
    return model


def compound_probabilities(model: Any, rows: list[dict[str, Any]]) -> np.ndarray:
    p = model.predict_proba([fc.features_for_request(row, False) for row in rows])
    classes = list(model.classes_)
    return p[:, classes.index(1)]


def binary_metrics(probabilities: np.ndarray, rows: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    y = np.array([int(row["expected"]["route"] == "compound") for row in rows])
    pred = (probabilities >= threshold).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {
        "examples": len(rows), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "accuracy": (tp + tn) / len(rows), "precision": precision,
        "recall": recall, "f1": f1,
    }


class AuditExpertController(aft.WeightedController):
    def __init__(
        self,
        route_models: dict[str, Any],
        authority_model: Any,
        ref_model: Any,
        structural_share: float,
        audit_expert: Any | None,
        audit_share: float,
        compound_model: Any | None = None,
        compound_threshold: float = 1.1,
        route_temperature: float = 1.0,
    ) -> None:
        super().__init__(route_models, authority_model, ref_model, structural_share, route_temperature)
        if audit_share < 0 or structural_share + audit_share >= 0.95:
            raise ValueError("invalid audit/structural fusion shares")
        self.audit_expert = audit_expert
        self.audit_share = audit_share if audit_expert is not None else 0.0
        self.compound_model = compound_model
        self.compound_threshold = compound_threshold
        remaining = 1.0 - structural_share - self.audit_share
        ratio = np.array([16.0, 16.0, 15.0], dtype=float)
        ratio /= ratio.sum()
        self.fusion_weights = {
            "char_ngram_logistic": float(remaining * ratio[0]),
            "word_ngram_logistic": float(remaining * ratio[1]),
            "compact_svd_semantic": float(remaining * ratio[2]),
            "structural_lexicon": float(structural_share),
        }
        if self.audit_share:
            self.fusion_weights["audit_route_expert"] = float(self.audit_share)

    def route_distribution(self, texts: list[str]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        parts: dict[str, np.ndarray] = {}
        request_features = [f"[REQ] {text}" for text in texts]
        for name, model in self.route_models.items():
            parts[name] = fc.class_proba_aligned(model, request_features, fc.ROUTES)
        if self.audit_expert is not None and self.audit_share:
            parts["audit_route_expert"] = fc.class_proba_aligned(self.audit_expert, request_features, fc.ROUTES)
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
        for name, probabilities in parts.items():
            logp += self.fusion_weights[name] * np.log(np.clip(probabilities, 1e-12, 1.0))
        logp /= sum(self.fusion_weights.values())
        logp /= max(0.05, self.route_temperature)
        logp -= logsumexp(logp, axis=1, keepdims=True)
        return np.exp(logp), parts

    def _compound_probability(self, row: dict[str, Any]) -> float:
        if self.compound_model is None:
            return 0.0
        p = self.compound_model.predict_proba([fc.features_for_request(row, False)])[0]
        classes = list(self.compound_model.classes_)
        return float(p[classes.index(1)])

    def _candidate_splits(self, text: str) -> list[list[str]]:
        candidates = []
        base = [part for part in fc.split_clauses(text) if part.strip()]
        if len(base) > 1:
            candidates.append(base)
        patterns = [
            r"\s+and\s+(?=(?:then\s+)?(?:draft|compose|summar|condense|compare|choose|decide|plan|map|outline|schedule|organize|check|verify|define|set|identify|pick|rank|write|prepare|create|build|give|tell|list|turn)\b)",
            r"\s+(?:plus|as well as|along with|while also)\s+",
            r"\s*;\s*",
            r"\s*,\s*(?:then|after that|and then|next)\s+",
        ]
        for pattern in patterns:
            parts = [part.strip() for part in re.split(pattern, text, maxsplit=1, flags=re.I) if part.strip()]
            if len(parts) > 1:
                candidates.append(parts)
        unique = []
        seen = set()
        for parts in candidates:
            key = tuple(fc.norm_text(part) for part in parts)
            if key not in seen:
                seen.add(key)
                unique.append(parts)
        return unique

    def _best_compound(self, row: dict[str, Any], base: fc.Prediction, compound_probability: float) -> fc.Prediction | None:
        best = None
        for clauses in self._candidate_splits(row["request"]):
            active = [clause for clause in clauses if not fc.is_negated_clause(clause)]
            if len(active) < 2:
                continue
            probabilities, parts = self.route_distribution(active)
            outcomes, confs, disagreements = [], [], []
            alternatives = []
            for index, probability in enumerate(probabilities):
                route_index = int(np.argmax(probability))
                route = fc.ROUTES[route_index]
                confidence = float(probability[route_index])
                structural = fc.structural_route_score(active[index])
                if structural and max(structural.values()) >= 0.32:
                    structural_route = max(structural, key=structural.get)
                    if probability[fc.ROUTES.index(structural_route)] >= 0.08:
                        route = structural_route
                        confidence = max(confidence, 0.84 + 0.10 * min(1.0, structural[structural_route]))
                votes = [fc.ROUTES[int(np.argmax(matrix[index]))] for matrix in parts.values()]
                disagreement = 1.0 - max(collections.Counter(votes).values()) / len(votes)
                if route == "clarify":
                    outcomes = []
                    break
                outcomes.append(route)
                confs.append(max(0.05, min(confidence, 0.82) * max(0.45, 1.0 - 0.45 * disagreement)))
                disagreements.append(disagreement)
                top = np.argsort(-probability)[:3]
                alternatives.extend({"route": fc.ROUTES[int(j)], "confidence": float(probability[int(j)])} for j in top)
            if len(outcomes) < 2 or len(set(outcomes)) < 2:
                continue
            score = compound_probability + 0.25 * min(confs) - 0.10 * max(disagreements)
            candidate = (score, outcomes, confs, disagreements, alternatives)
            if best is None or candidate[0] > best[0]:
                best = candidate
        if best is None:
            return None
        _, outcomes, confs, disagreements, alternatives = best
        return fc.Prediction(
            "compound", base.authority, base.context, outcomes, base.reference_type,
            base.support_source, min(min(confs), compound_probability),
            "trained-compound-controller", alternatives[:3], max(disagreements),
        )

    def predict_one(self, row: dict[str, Any]) -> fc.Prediction:
        base = super().predict_one(row)
        if base.authority != "allow" or base.context != "ready" or base.route == "compound":
            return base
        probability = self._compound_probability(row)
        if probability < self.compound_threshold:
            return base
        candidate = self._best_compound(row, base, probability)
        return candidate if candidate is not None else base


def compact(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "errors"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-corpus", required=True)
    parser.add_argument("--frozen-challenge", required=True)
    parser.add_argument("--legacy-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=92031)
    args = parser.parse_args()

    audit_path = Path(args.audit_corpus)
    challenge_path = Path(args.frozen_challenge)
    legacy_dir = Path(args.legacy_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if aft.sha256_file(audit_path) != aft.AUDIT_CORPUS_SHA256:
        raise SystemExit("audit corpus digest mismatch")
    if aft.sha256_file(challenge_path) != aft.FROZEN_CHALLENGE_SHA256:
        raise SystemExit("frozen challenge digest mismatch")

    raw_audit = json.loads(audit_path.read_text())
    audit_rows = [aft.audit_row(row, index) for index, row in enumerate(raw_audit)]
    audit_route_train, audit_route_dev, audit_skipped = aft.stratified_audit_split(audit_rows)
    audit_binary_train, audit_binary_dev = binary_audit_split(audit_rows)

    train_raw = fc.generate_dataset(args.seed + 1, "train", 800, 80, 160, 80, 80)
    dev_raw = fc.generate_dataset(args.seed + 2, "dev", 240, 32, 72, 32, 32)
    seen: set[str] = set()
    train, dropped_train = fc.unique_rows(train_raw, seen)
    dev, dropped_dev = fc.unique_rows(dev_raw, seen)
    route_train = aft.explode_route_examples(train)
    route_dev = aft.explode_route_examples(dev)

    challenge = json.loads(challenge_path.read_text())
    overlap = {fc.norm_input(row) for row in challenge} & {fc.norm_input(row) for row in train + dev + audit_rows}
    if overlap:
        raise SystemExit("frozen exact overlap detected")

    authority_model = fc.make_pipeline(
        fc.HashingVectorizer(analyzer="char_wb", ngram_range=(3, 5), n_features=4096, alternate_sign=False, norm="l2"),
        fc.SGDClassifier(loss="log_loss", alpha=2e-5, max_iter=35, tol=1e-4, random_state=args.seed + 9, class_weight="balanced"),
    )
    authority_model.fit([fc.features_for_request(row, False) for row in train], [row["expected"]["authority"] for row in train])
    ref_model = fc.make_pipeline(
        fc.HashingVectorizer(analyzer="word", ngram_range=(1, 3), n_features=4096, alternate_sign=False, norm="l2"),
        fc.SGDClassifier(loss="log_loss", alpha=2e-5, max_iter=35, tol=1e-4, random_state=args.seed + 10, class_weight="balanced"),
    )
    ref_model.fit([fc.features_for_request(row, False) for row in train], [row["expected"]["reference_type"] for row in train])

    base_models = aft.train_route_models(route_train, args.seed + 20)
    audit_expert_train = fit_audit_expert(audit_route_train, args.seed + 30)
    route_trace = []
    best_route_key = None
    best_route_spec = None
    for structural_share in STRUCTURAL_SHARES:
        for audit_share in AUDIT_EXPERT_SHARES:
            if structural_share + audit_share >= 0.95:
                continue
            controller = AuditExpertController(
                base_models, authority_model, ref_model, structural_share,
                audit_expert_train if audit_share else None, audit_share,
            )
            generated = aft.direct_route_metrics(controller, route_dev)
            authored = aft.direct_route_metrics(controller, audit_route_dev)
            key = (
                round(min(generated["accuracy"], authored["accuracy"]), 12),
                round(aft.harmonic(generated["accuracy"], authored["accuracy"]), 12),
                round(generated["accuracy"], 12),
                -audit_share,
            )
            route_trace.append({
                "structural_share": structural_share, "audit_share": audit_share,
                "generated_route": generated, "audit_holdout_route": authored,
                "selection_key": list(key),
            })
            if best_route_key is None or key > best_route_key:
                best_route_key = key
                best_route_spec = (structural_share, audit_share)
    if best_route_spec is None:
        raise SystemExit("no route fusion selected")

    compound_train_rows = train + audit_binary_train
    compound_model_train = fit_compound_model(compound_train_rows, args.seed + 40)
    p_generated = compound_probabilities(compound_model_train, dev)
    p_audit = compound_probabilities(compound_model_train, audit_binary_dev)
    compound_trace = []
    best_compound_key = None
    best_threshold = None
    for threshold in COMPOUND_THRESHOLDS:
        generated = binary_metrics(p_generated, dev, threshold)
        authored = binary_metrics(p_audit, audit_binary_dev, threshold)
        key = (
            round(min(generated["f1"], authored["f1"]), 12),
            round(aft.harmonic(generated["f1"], authored["f1"]), 12),
            round(min(generated["accuracy"], authored["accuracy"]), 12),
            -threshold,
        )
        compound_trace.append({
            "threshold": threshold, "generated": generated,
            "audit_holdout": authored, "selection_key": list(key),
        })
        if best_compound_key is None or key > best_compound_key:
            best_compound_key = key
            best_threshold = threshold
    if best_threshold is None:
        raise SystemExit("no compound threshold selected")

    structural_share, audit_share = best_route_spec
    selected_pre_refit = AuditExpertController(
        base_models, authority_model, ref_model, structural_share,
        audit_expert_train if audit_share else None, audit_share,
    )
    selected_temperature = aft.fit_temperature(selected_pre_refit, route_dev + audit_route_dev)

    audit_expert_full = fit_audit_expert(audit_route_train + audit_route_dev, args.seed + 31) if audit_share else None
    compound_model_full = fit_compound_model(train + audit_rows, args.seed + 41)
    selected = AuditExpertController(
        base_models, authority_model, ref_model, structural_share,
        audit_expert_full, audit_share, compound_model_full,
        best_threshold, selected_temperature,
    )
    baseline_seed = AuditExpertController(base_models, authority_model, ref_model, 0.4777777777777778, None, 0.0)
    baseline = AuditExpertController(
        base_models, authority_model, ref_model, 0.4777777777777778,
        None, 0.0, None, 1.1, aft.fit_temperature(baseline_seed, route_dev),
    )

    selected_dev = fc.evaluate(selected, dev, "generated_development_selected")
    baseline_dev = fc.evaluate(baseline, dev, "generated_development_baseline")
    selected_blind = fc.evaluate(selected, challenge, "frozen_blind_429_selected")
    baseline_blind = fc.evaluate(baseline, challenge, "frozen_blind_429_baseline")

    legacy_evidence = {}
    selected_legacy = {}
    baseline_legacy = {}
    for name, expected in aft.LEGACY.items():
        rows = aft.load_legacy(legacy_dir / f"{name}.jsonl", expected)
        legacy_evidence[name] = {"sha256": expected["sha256"], "rows": len(rows)}
        selected_legacy[name] = aft.evaluate_legacy(selected, rows)
        baseline_legacy[name] = aft.evaluate_legacy(baseline, rows)

    model_path = out / "factorized-audit-compound-selected.joblib"
    joblib.dump({
        "schema": "archie-factorized-audit-compound/v1",
        "route_models": selected.route_models,
        "audit_route_expert": selected.audit_expert,
        "authority_model": selected.authority_model,
        "reference_model": selected.ref_model,
        "compound_model": selected.compound_model,
        "fusion_weights": selected.fusion_weights,
        "compound_threshold": selected.compound_threshold,
        "route_temperature": selected.route_temperature,
    }, model_path, compress=("gzip", 3))

    receipt = {
        "schema": "archie-factorized-audit-compound-experiment/v1",
        "seed": args.seed,
        "selection": {
            "route_trace": route_trace,
            "compound_trace": compound_trace,
            "selected_structural_share": structural_share,
            "selected_audit_share": audit_share,
            "selected_compound_threshold": best_threshold,
            "selected_route_temperature": selected_temperature,
            "frozen_evidence_used_for_selection": False,
        },
        "data": {
            "audit_corpus_sha256": aft.AUDIT_CORPUS_SHA256,
            "audit_rows": len(audit_rows),
            "audit_route_train": len(audit_route_train),
            "audit_route_holdout": len(audit_route_dev),
            "audit_route_skipped": audit_skipped,
            "audit_binary_train": len(audit_binary_train),
            "audit_binary_holdout": len(audit_binary_dev),
            "generated_train": len(train),
            "generated_development": len(dev),
            "generated_drops": {"train": dropped_train, "development": dropped_dev},
            "frozen_challenge_sha256": aft.FROZEN_CHALLENGE_SHA256,
            "legacy": legacy_evidence,
        },
        "selected": {
            "fusion_weights": selected.fusion_weights,
            "compound_threshold": selected.compound_threshold,
            "generated_development": compact(selected_dev),
            "frozen_blind_429": compact(selected_blind),
            "exact_legacy": selected_legacy,
        },
        "baseline": {
            "fusion_weights": baseline.fusion_weights,
            "generated_development": compact(baseline_dev),
            "frozen_blind_429": compact(baseline_blind),
            "exact_legacy": baseline_legacy,
        },
        "model": {"path": model_path.name, "bytes": model_path.stat().st_size, "sha256": aft.sha256_file(model_path)},
        "promotion": "not-admitted",
        "production_changed": False,
        "admission_reason": "The frozen 429 pack has become iterative research evidence and this experiment still lacks a new untouched full-runtime 310-case admission pack plus packaging and resource parity receipts.",
    }
    receipt["receipt_digest"] = aft.digest_json(receipt)
    (out / "factorized-audit-compound-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    comparison = {
        "schema": "archie-factorized-audit-compound-comparison/v1",
        "selected_spec": {
            "structural_share": structural_share, "audit_share": audit_share,
            "compound_threshold": best_threshold, "route_temperature": selected_temperature,
        },
        "baseline_blind_full": baseline_blind["accuracy"],
        "selected_blind_full": selected_blind["accuracy"],
        "baseline_ordered_compound": baseline_blind["per_category"].get("ordered_compound"),
        "selected_ordered_compound": selected_blind["per_category"].get("ordered_compound"),
        "selected_legacy_controller_route": {name: value["controller_route_accuracy"] for name, value in selected_legacy.items()},
        "selected_legacy_direct_semantic": {name: value["direct_semantic_accuracy"] for name, value in selected_legacy.items()},
        "model_sha256": receipt["model"]["sha256"],
        "receipt_digest": receipt["receipt_digest"],
        "promotion": "not-admitted",
        "production_changed": False,
    }
    comparison["comparison_digest"] = aft.digest_json(comparison)
    (out / "factorized-audit-compound-comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    print(json.dumps(comparison, indent=2), flush=True)


if __name__ == "__main__":
    main()
