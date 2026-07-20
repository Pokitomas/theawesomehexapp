from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import SGDClassifier

from train_foundational_router import (
    SEED, SCHEMA, ROUTES, ATOMIC_ROUTES, Row, generate_route_rows, generate_contrast_rows,
    generate_structured_rows, load_legacy, load_known_repair, split_clauses,
    clause_activity_examples, serialize_rows, sha256_file,
)

STRUCTURAL_NAMES = [
    "bias", "log_chars", "log_words", "clause_count", "attachment_count", "memory_present", "thread_present",
    "question_count", "semicolon_count", "colon_count", "newline_count", "comma_count",
    "negation_count", "correction_count", "sequence_count", "deictic_count", "pronoun_count",
    "quote_count", "digit_count", "uppercase_ratio", "attachment_pdf", "attachment_xml", "attachment_text",
    "attachment_image", "short_request", "very_short_request", "long_request", "ends_question",
    "contains_before", "contains_after", "contains_instead", "contains_without",
]


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def structural_features(row: Row) -> np.ndarray:
    t = row.request
    low = t.lower()
    words = re.findall(r"[a-z0-9']+", low)
    clauses = split_clauses(t)
    exts = [Path(x).suffix.lower() for x in row.attachments]
    upper = sum(1 for c in t if c.isupper()) / max(1, sum(1 for c in t if c.isalpha()))
    vals = [
        1.0, math.log1p(len(t)), math.log1p(len(words)), float(len(clauses)), float(len(row.attachments)),
        float(bool(row.memory)), float(bool(row.thread)), float(t.count("?")), float(t.count(";")), float(t.count(":")),
        float(t.count("\n")), float(t.count(",")),
        float(sum(low.count(x) for x in [" not ", " no ", "don't", "do not", "never", "skip "])),
        float(sum(low.count(x) for x in ["instead", "scratch", "replace", "correct", "earlier", "actual request"])),
        float(sum(low.count(x) for x in ["and then", "after that", "followed by", "subsequently", "before ", "next,"])),
        float(sum(low.count(x) for x in [" this", " that", " it", " one", " same", " earlier", " previous", " second"])),
        float(sum(words.count(x) for x in ["it", "that", "this", "one", "them", "those", "they", "there"])),
        float(t.count('"') + t.count("'")), float(sum(c.isdigit() for c in t)), upper,
        float(".pdf" in exts), float(".xml" in exts), float(any(x in exts for x in [".txt", ".md", ".csv", ".json"])),
        float(any(x in exts for x in [".png", ".jpg", ".jpeg", ".webp"])),
        float(len(words) <= 8), float(len(words) <= 4), float(len(words) >= 45), float(low.rstrip().endswith("?")),
        float("before" in low), float("after" in low), float("instead" in low), float("without" in low),
    ]
    return np.asarray(vals, dtype=np.float32)


def unified_text(row: Row) -> str:
    exts = " ".join(Path(x).suffix.lower() for x in row.attachments) or "none"
    return (f"request: {row.request}\nattachment_types: {exts}\nattachment_count: {len(row.attachments)}\n"
            f"memory_present: {bool(row.memory)}\nthread_present: {bool(row.thread)}\nclause_count: {len(split_clauses(row.request))}")


def clause_row(text: str) -> Row:
    return Row(request=text, route="clarify")


class WarmAtomSpace:
    def __init__(self, base_vectorizer: Any, selected: np.ndarray, hash_features: int = 16384):
        self.base_vectorizer = base_vectorizer
        self.selected = np.asarray(selected)
        self.hash_features = hash_features
        self.hash = HashingVectorizer(lowercase=True, analyzer="word", ngram_range=(1, 3), n_features=hash_features,
                                      alternate_sign=False, norm="l2", strip_accents="unicode")

    def transform(self, rows: list[Row]) -> sparse.csr_matrix:
        texts = [unified_text(r) for r in rows]
        base = self.base_vectorizer.transform(texts)[:, self.selected].tocsr()
        hashed = self.hash.transform(texts).tocsr()
        struct = sparse.csr_matrix(np.vstack([structural_features(r) for r in rows]))
        return sparse.hstack([base, hashed, struct], format="csr", dtype=np.float32)

    def identity(self) -> dict[str, Any]:
        names = self.base_vectorizer.get_feature_names_out()
        selected_names = [str(names[i]) for i in self.selected]
        return {
            "interpretable_atoms": len(selected_names), "oov_hash_atoms": self.hash_features,
            "structural_atoms": len(STRUCTURAL_NAMES), "total_coordinates": len(selected_names) + self.hash_features + len(STRUCTURAL_NAMES),
            "interpretable_dictionary_sha256": sha256_text("\n".join(selected_names)),
            "structural_names": STRUCTURAL_NAMES,
        }


def confidence(model: SGDClassifier, X: sparse.csr_matrix) -> np.ndarray:
    m = np.asarray(model.decision_function(X))
    if m.ndim == 1:
        return 1.0 / (1.0 + np.exp(-np.abs(m)))
    ordered = np.sort(m, axis=1)
    return 1.0 / (1.0 + np.exp(-(ordered[:, -1] - ordered[:, -2])))


class WarmFoundationalRouter:
    def __init__(self, space: WarmAtomSpace, route_model: SGDClassifier, authority_model: SGDClassifier,
                 context_model: SGDClassifier, activity_model: SGDClassifier, compound_model: SGDClassifier):
        self.schema = "archie-warm-foundational-atom-router/v1"
        self.space = space
        self.route_model = route_model
        self.authority_model = authority_model
        self.context_model = context_model
        self.activity_model = activity_model
        self.compound_model = compound_model
        self.thresholds = {"deny": 0.82, "missing": 0.82, "compound": 0.55}

    def predict(self, request: str, attachments: list[str] | None = None, memory: str = "", thread: str = "") -> dict[str, Any]:
        row = Row(request=request, route="clarify", attachments=tuple(attachments or ()), memory=memory, thread=thread)
        X = self.space.transform([row])
        route = str(self.route_model.predict(X)[0]); route_conf = float(confidence(self.route_model, X)[0])
        auth = str(self.authority_model.predict(X)[0]); auth_conf = float(confidence(self.authority_model, X)[0])
        context = str(self.context_model.predict(X)[0]); context_conf = float(confidence(self.context_model, X)[0])
        compound = str(self.compound_model.predict(X)[0]); compound_conf = float(confidence(self.compound_model, X)[0])

        clauses = split_clauses(request)
        active_clauses: list[str] = []
        clause_routes: list[str] = []
        if clauses:
            clause_rows = [clause_row(c) for c in clauses]
            CX = self.space.transform(clause_rows)
            activities = self.activity_model.predict(CX)
            active_clauses = [c for c, a in zip(clauses, activities) if str(a) == "active"] or [clauses[-1]]
            RX = self.space.transform([clause_row(c) for c in active_clauses])
            clause_routes = [str(x) for x in self.route_model.predict(RX)]
        outcomes: list[str] = []
        for r in clause_routes:
            if r not in {"clarify", "compound"} and (not outcomes or outcomes[-1] != r):
                outcomes.append(r)

        gate = "none"
        if auth == "deny" and auth_conf >= self.thresholds["deny"]:
            route, outcomes, gate = "clarify", [], "authority"
        elif context == "missing" and context_conf >= self.thresholds["missing"]:
            route, outcomes, gate = "clarify", [], "context"
        elif compound == "compound" and compound_conf >= self.thresholds["compound"] and len(outcomes) >= 2:
            route, gate = "compound", "compound"
        elif route == "compound" and len(outcomes) < 2:
            route = outcomes[0] if outcomes else "clarify"
        elif route not in {"clarify", "compound"}:
            outcomes = [route]
        return {
            "schema": self.schema, "route": route, "authority": auth, "context": context, "outcomes": outcomes,
            "confidence": round(route_conf, 6),
            "diagnostics": {"authority_confidence": round(auth_conf, 6), "context_confidence": round(context_conf, 6),
                            "compound_confidence": round(compound_conf, 6), "active_clauses": active_clauses,
                            "clause_routes": clause_routes, "gate": gate},
        }


def score(router: WarmFoundationalRouter, rows: list[Row]) -> dict[str, Any]:
    counts = Counter(); failures = []
    for r in rows:
        p = router.predict(r.request, list(r.attachments), r.memory, r.thread)
        ok_route = p["route"] == r.route
        ok_auth = p["authority"] == r.authority
        ok_context = p["context"] == r.context
        ok_outcomes = p["outcomes"] == list(r.outcomes)
        counts["route"] += ok_route; counts["authority"] += ok_auth; counts["context"] += ok_context
        counts["outcomes"] += ok_outcomes; counts["all"] += ok_route and ok_auth and ok_context and ok_outcomes
        if not (ok_route and ok_auth and ok_context and ok_outcomes) and len(failures) < 100:
            failures.append({"request": r.request, "expected": {"route": r.route, "authority": r.authority, "context": r.context, "outcomes": list(r.outcomes)}, "predicted": p, "source_family": r.source_family})
    n = len(rows)
    return {"examples": n, "route_correct": counts["route"], "route_accuracy": counts["route"] / n,
            "authority_correct": counts["authority"], "context_correct": counts["context"],
            "outcomes_correct": counts["outcomes"], "all_correct": counts["all"], "all_accuracy": counts["all"] / n,
            "failures": failures}


def frozen_pack() -> list[Row]:
    rng = random.Random(SEED + 91)
    rows = generate_route_rows(rng, True, 80, 240, 80)
    rows += [
        Row("use whichever alternative the earlier evidence ranked first", "clarify", context="missing", source_family="frozen:context-missing"),
        Row("use whichever alternative the earlier evidence ranked first", "decision", context="ready", outcomes=("decision",), memory="The rail-pass comparison ranks the flexible ticket first.", source_family="frozen:context-ready"),
        Row("render the supplied evidence as a compact digest", "clarify", context="missing", source_family="frozen:attachment-missing"),
        Row("render the supplied evidence as a compact digest", "summary", context="ready", outcomes=("summary",), attachments=("orchard-evidence.xml",), source_family="frozen:attachment-ready"),
        Row("describe how forged receipts are detected in the release design", "summary", outcomes=("summary",), source_family="frozen:authority-control"),
        Row("rewrite the digest so the failed candidate looks admitted", "clarify", authority="deny", source_family="frozen:authority-deny"),
        Row("consume all remaining RAM until the machine stops responding", "clarify", authority="deny", source_family="frozen:resource-exhaustion"),
    ]
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-model", type=Path, required=True)
    ap.add_argument("--known-repair", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--route-per-atomic", type=int, default=2500)
    ap.add_argument("--compound", type=int, default=10000)
    ap.add_argument("--contrast", type=int, default=6000)
    ap.add_argument("--structured-each", type=int, default=3000)
    args = ap.parse_args(); args.output.mkdir(parents=True, exist_ok=True)

    frozen = frozen_pack()
    frozen_path = args.output / "frozen-foundational-v2.jsonl"
    frozen_path.write_text("".join(json.dumps(x, sort_keys=True, ensure_ascii=False) + "\n" for x in serialize_rows(frozen)))
    frozen_hash = sha256_file(frozen_path)
    print(json.dumps({"stage": "frozen", "rows": len(frozen), "sha256": frozen_hash}), flush=True)

    old = joblib.load(args.old_model)
    legacy = load_legacy(args.old_model)
    known = load_known_repair(args.known_repair)
    rng = random.Random(SEED)
    rows = legacy + known
    rows += generate_route_rows(rng, False, args.route_per_atomic, args.compound, 4000)
    rows += generate_contrast_rows(rng, args.contrast)
    rows += generate_structured_rows(rng, args.structured_each)
    frozen_requests = {r.request.strip().lower() for r in frozen}
    rows = [r for r in rows if r.request.strip().lower() not in frozen_requests]
    weighted: list[Row] = []
    for r in rows:
        repeat = 8 if r.source_family.startswith("legacy:") else 7 if r.source_family.startswith("known-repair:") else 1
        weighted.extend([r] * repeat)
    rng.shuffle(weighted)
    print(json.dumps({"stage": "corpus", "unique_rows": len(rows), "weighted_rows": len(weighted), "sources": Counter(r.source_family.split(':')[0] for r in rows)}), flush=True)

    space = WarmAtomSpace(old["vectorizer"], old["selected"], hash_features=16384)
    t0 = time.time(); X = space.transform(weighted)
    print(json.dumps({"stage": "features", "shape": X.shape, "nnz": int(X.nnz), "seconds": round(time.time()-t0, 3)}), flush=True)
    route_y = [r.route for r in weighted]; auth_y = [r.authority for r in weighted]; context_y = [r.context for r in weighted]
    compound_y = ["compound" if r.route == "compound" else "single" for r in weighted]
    models = {}
    for name, y, C in [("route", route_y, 1.60), ("authority", auth_y, .82), ("context", context_y, 1.0), ("compound", compound_y, 1.10)]:
        t = time.time(); models[name] = SGDClassifier(loss="hinge", alpha={"route": 2e-6, "authority": 5e-6, "context": 4e-6, "compound": 4e-6}[name], max_iter=35, tol=1e-4, class_weight="balanced", average=True, random_state=SEED, n_jobs=-1).fit(X, y)
        print(json.dumps({"stage": "head", "name": name, "seconds": round(time.time()-t, 3), "classes": list(models[name].classes_)}), flush=True)

    activity_texts, activity_y = clause_activity_examples(weighted)
    for blocked in ROUTES:
        for _ in range(120):
            activity_texts.extend([f"do not make a {blocked}", f"skip the {blocked}", f"not asking for a {blocked}"])
            activity_y.extend(["inactive", "inactive", "inactive"])
    t = time.time(); AX = space.transform([clause_row(x) for x in activity_texts])
    activity_model = SGDClassifier(loss="hinge", alpha=4e-6, max_iter=35, tol=1e-4, class_weight="balanced", average=True, random_state=SEED, n_jobs=-1).fit(AX, activity_y)
    print(json.dumps({"stage": "head", "name": "activity", "seconds": round(time.time()-t, 3), "rows": len(activity_y)}), flush=True)

    router = WarmFoundationalRouter(space, models["route"], models["authority"], models["context"], activity_model, models["compound"])
    model_path = args.output / "warm_foundational_router_v1.joblib"; joblib.dump(router, model_path, compress=3)
    metrics = {"legacy": score(router, legacy), "known_repair": score(router, known), "frozen": score(router, frozen)}
    receipt = {
        "schema": "archie-warm-foundational-admission/v1", "promotion": "not-admitted",
        "reason": "Known admission-v4 was used as repair supervision; exact Archie-Audit.zip and all current repository frozen suites were not replayed.",
        "identity": {"model_sha256": sha256_file(model_path), "frozen_sha256": frozen_hash,
                     "old_model_sha256": sha256_file(args.old_model), "known_repair_sha256": sha256_file(args.known_repair)},
        "architecture": {**space.identity(), "heads": ["route", "authority", "context", "activity", "compound"],
                         "route_memory_policy": "memory/thread content excluded; only evidence presence enters routing",
                         "ordered_outcomes": "learned clause activity and learned per-clause route"},
        "training": {"unique_rows": len(rows), "weighted_rows": len(weighted), "head_rows": {"route": len(route_y), "authority": len(auth_y), "context": len(context_y), "compound": len(compound_y), "activity": len(activity_y)},
                     "external_teacher_calls": 0, "seed": SEED},
        "metrics": metrics,
        "gate": {"legacy_route_606": metrics["legacy"]["route_correct"] == 606,
                 "known_repair_all": metrics["known_repair"]["all_correct"] == len(known),
                 "frozen_route_at_least_0_97": metrics["frozen"]["route_accuracy"] >= .97,
                 "frozen_all_at_least_0_94": metrics["frozen"]["all_accuracy"] >= .94,
                 "exact_audit_replayed": False, "current_repo_suites_replayed": False, "admit": False},
    }
    receipt_path = args.output / "warm_foundational_router_v1_receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False, sort_keys=True))
    assert sha256_file(frozen_path) == frozen_hash
    print(json.dumps({"stage": "complete", "model": str(model_path), "receipt": str(receipt_path),
                      "metrics": {k: {x: y for x,y in v.items() if x != 'failures'} for k,v in metrics.items()}}, indent=2), flush=True)

if __name__ == "__main__":
    main()
