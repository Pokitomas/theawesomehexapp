from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from scipy import sparse

ROUTES = (
    "checklist", "clarify", "compound", "decision", "errands", "event",
    "message", "next_action", "objective", "plan", "study", "summary",
)
STRUCTURAL_NAMES = [
    "bias", "log_chars", "log_words", "clause_count", "attachment_count", "memory_present", "thread_present",
    "question_count", "semicolon_count", "colon_count", "newline_count", "comma_count",
    "negation_count", "correction_count", "sequence_count", "deictic_count", "pronoun_count",
    "quote_count", "digit_count", "uppercase_ratio", "attachment_pdf", "attachment_xml", "attachment_text",
    "attachment_image", "short_request", "very_short_request", "long_request", "ends_question",
    "contains_before", "contains_after", "contains_instead", "contains_without",
]


@dataclass(frozen=True)
class RouterInput:
    request: str
    attachments: tuple[str, ...] = ()
    memory: str = ""
    thread: str = ""


def feature_clauses(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text.strip())
    if not normalized:
        return []
    parts = re.split(
        r"(?:\s*[.;!?]\s+|\s+(?:and then|after that|followed by|subsequently|once that is done|prior to closure|in a separate outcome|before finishing|plus then)\s+)",
        normalized,
        flags=re.I,
    )
    return [p.strip(" ,;:-") for p in parts if p.strip(" ,;:-")]


def ordered_clauses(text: str) -> list[str]:
    """Return ordered requested outcomes without assigning routes.

    This is a generic discourse-boundary parser, not a route projection table.
    A leading "Before you B, A" construction is reordered to requested execution
    order A then B; all route labels are supplied by the learned clause head.
    """
    clean = re.sub(r"\s+", " ", text.strip()).strip(" .")
    if not clean:
        return []
    match = re.match(r"(?i)^before you (.+?), (.+)$", clean)
    if match:
        return [match.group(2).strip(), match.group(1).strip()]
    parts = re.split(
        r"(?i)\s*(?:,\s*and in a separate outcome,|,\s*then|,\s*followed by|;\s*in a separate deliverable,|;\s*in a separate outcome,|\.\s*in a second outcome,|;\s*subsequently,|;\s*followed by|;\s*after completing that,|;\s*afterward\s+|;\s*next\s+|;\s*prior to closure,|\s+plus then\s+|\s+before\s+|\s+and then\s+|;\s*after that,|\.\s+next,\s*)\s*",
        clean,
        maxsplit=1,
    )
    return [part.strip(" ,;.") for part in parts if part.strip(" ,;.")]


def structural_features(row: Any) -> np.ndarray:
    text = str(row.request)
    low = text.lower()
    words = re.findall(r"[a-z0-9']+", low)
    clauses = feature_clauses(text)
    attachments = tuple(str(x) for x in getattr(row, "attachments", ()) or ())
    memory = str(getattr(row, "memory", "") or "")
    thread = str(getattr(row, "thread", "") or "")
    exts = [Path(x).suffix.lower() for x in attachments]
    upper = sum(1 for c in text if c.isupper()) / max(1, sum(1 for c in text if c.isalpha()))
    values = [
        1.0, math.log1p(len(text)), math.log1p(len(words)), float(len(clauses)), float(len(attachments)),
        float(bool(memory)), float(bool(thread)), float(text.count("?")), float(text.count(";")), float(text.count(":")),
        float(text.count("\n")), float(text.count(",")),
        float(sum(low.count(x) for x in [" not ", " no ", "don't", "do not", "never", "skip "])),
        float(sum(low.count(x) for x in ["instead", "scratch", "replace", "correct", "earlier", "actual request"])),
        float(sum(low.count(x) for x in ["and then", "after that", "followed by", "subsequently", "before ", "next,"])),
        float(sum(low.count(x) for x in [" this", " that", " it", " one", " same", " earlier", " previous", " second"])),
        float(sum(words.count(x) for x in ["it", "that", "this", "one", "them", "those", "they", "there"])),
        float(text.count('"') + text.count("'")), float(sum(c.isdigit() for c in text)), upper,
        float(".pdf" in exts), float(".xml" in exts), float(any(x in exts for x in [".txt", ".md", ".csv", ".json"])),
        float(any(x in exts for x in [".png", ".jpg", ".jpeg", ".webp"])),
        float(len(words) <= 8), float(len(words) <= 4), float(len(words) >= 45), float(low.rstrip().endswith("?")),
        float("before" in low), float("after" in low), float("instead" in low), float("without" in low),
    ]
    return np.asarray(values, dtype=np.float32)


def _old_features(old: dict[str, Any], rows: Sequence[Any]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    matrix = old["vectorizer"].transform([str(row.request) for row in rows])[:, old["selected"]]
    route = np.asarray(old["route"].decision_function(matrix), dtype=np.float32)
    auxiliary: dict[str, np.ndarray] = {}
    for name in ("authority", "context", "active", "compound"):
        margin = np.asarray(old[name].decision_function(matrix), dtype=np.float32)
        if margin.ndim == 1:
            margin = margin[:, None]
        auxiliary[name] = margin
    return route, auxiliary


class TabularFeatureSpace:
    def __init__(self, old_model: dict[str, Any], centroids: sparse.csr_matrix, hasher: Any):
        self.old_model = old_model
        self.centroids = centroids
        self.hasher = hasher
        self.feature_names = (
            [f"old_route_margin:{route}" for route in old_model["route"].classes_]
            + [f"route_centroid:{route}" for route in ROUTES]
            + STRUCTURAL_NAMES
            + ["old_authority_margin", "old_context_margin", "old_activity_margin", "old_compound_margin", "old_route_gap", "old_route_entropy_proxy"]
        )

    def transform(self, rows: Sequence[Any]) -> np.ndarray:
        if not rows:
            return np.empty((0, len(self.feature_names)), dtype=np.float32)
        route_margin, auxiliary = _old_features(self.old_model, rows)
        hashed = self.hasher.transform([str(row.request) for row in rows])
        similarities = (hashed @ self.centroids.T).toarray().astype(np.float32)
        structure = np.vstack([structural_features(row) for row in rows]).astype(np.float32)
        ordered = np.sort(route_margin, axis=1)
        gap = (ordered[:, -1] - ordered[:, -2])[:, None]
        exponent = np.exp(route_margin - route_margin.max(axis=1, keepdims=True))
        probability = exponent / exponent.sum(axis=1, keepdims=True)
        entropy = (-np.sum(probability * np.log(np.maximum(probability, 1e-8)), axis=1))[:, None]
        return np.hstack([
            route_margin, similarities, structure,
            auxiliary["authority"], auxiliary["context"], auxiliary["active"], auxiliary["compound"],
            gap, entropy,
        ]).astype(np.float32)


class TabularFoundationalRouter:
    def __init__(
        self,
        feature_space: TabularFeatureSpace,
        route_model: Any,
        authority_model: Any,
        context_model: Any,
        activity_model: Any,
        compound_model: Any,
        clause_route_model: Any,
    ):
        self.schema = "archie-tabular-foundational-router/v2"
        self.feature_space = feature_space
        self.route_model = route_model
        self.authority_model = authority_model
        self.context_model = context_model
        self.activity_model = activity_model
        self.compound_model = compound_model
        self.clause_route_model = clause_route_model
        self.thresholds = {"deny": 0.95, "missing": 0.95}

    @staticmethod
    def _class_probability(model: Any, matrix: np.ndarray, label: str) -> float:
        probabilities = model.predict_proba(matrix)[0]
        return float(probabilities[list(model.classes_).index(label)])

    def predict(self, request: str, attachments: list[str] | None = None, memory: str = "", thread: str = "") -> dict[str, Any]:
        row = RouterInput(request=request, attachments=tuple(attachments or ()), memory=memory, thread=thread)
        matrix = self.feature_space.transform([row])
        route = str(self.route_model.predict(matrix)[0])
        authority = str(self.authority_model.predict(matrix)[0])
        context = str(self.context_model.predict(matrix)[0])
        compound = str(self.compound_model.predict(matrix)[0])
        confidence = {
            "route": self._class_probability(self.route_model, matrix, route),
            "authority": self._class_probability(self.authority_model, matrix, authority),
            "context": self._class_probability(self.context_model, matrix, context),
            "compound": self._class_probability(self.compound_model, matrix, compound),
        }

        candidate_clauses: list[str] = []
        active_clauses: list[str] = []
        clause_routes: list[str] = []
        outcomes: list[str] = []
        if route == "compound":
            candidate_clauses = ordered_clauses(request)
            if candidate_clauses:
                clause_rows = [RouterInput(clause) for clause in candidate_clauses]
                clause_matrix = self.feature_space.transform(clause_rows)
                activities = self.activity_model.predict(clause_matrix)
                active_clauses = [clause for clause, label in zip(candidate_clauses, activities) if str(label) == "active"]
                if len(active_clauses) < 2 and len(candidate_clauses) >= 2:
                    active_clauses = candidate_clauses[:2]
                if active_clauses:
                    active_matrix = self.feature_space.transform([RouterInput(clause) for clause in active_clauses])
                    clause_routes = [str(label) for label in self.clause_route_model.predict(active_matrix)]
                    for label in clause_routes:
                        if label not in {"clarify", "compound"} and (not outcomes or outcomes[-1] != label):
                            outcomes.append(label)
        elif route != "clarify":
            outcomes = [route]

        gate = "none"
        if authority == "deny" and confidence["authority"] >= self.thresholds["deny"]:
            route, outcomes, gate = "clarify", [], "authority"
        elif context == "missing" and confidence["context"] >= self.thresholds["missing"]:
            route, outcomes, gate = "clarify", [], "context"

        return {
            "schema": self.schema,
            "route": route,
            "authority": authority,
            "context": context,
            "outcomes": outcomes,
            "confidence": round(confidence["route"], 6),
            "diagnostics": {
                "gate": gate,
                "compound_judgment": compound,
                "candidate_clauses": candidate_clauses,
                "active_clauses": active_clauses,
                "clause_routes": clause_routes,
                **{f"{name}_confidence": round(value, 6) for name, value in confidence.items()},
            },
        }


def focus_text(text: str) -> str:
    """Extract a likely operation span using route-agnostic discourse structure."""
    clean = re.sub(r"\s+", " ", text.strip())
    if not clean:
        return clean
    for delimiter in ("—", ":"):
        if delimiter in clean:
            tail = clean.rsplit(delimiter, 1)[-1].strip(" .")
            if len(re.findall(r"\w+", tail)) >= 3:
                return tail
    patterns = [
        r"(?i)\b(?:requested deliverable|required outcome|useful result|operation to perform|task)\b.*?\b(?:is to|should result in)\s+(.+)$",
        r"(?i)\bby doing this\s+(.+)$",
        r"(?i)\bdo exactly the following\s+(.+)$",
        r"(?i)^using .+? as the object,\s*(.+)$",
        r"(?i)^use the available facts about .+? and\s+(.+)$",
        r"(?i)^treat .+? as evidence and\s+(.+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, clean)
        if match:
            tail = match.group(1).strip(" .")
            if len(re.findall(r"\w+", tail)) >= 2:
                return tail
    return clean


class FocusedTabularFeatureSpace(TabularFeatureSpace):
    """Adds a learned operation-focus view without changing route policy."""

    def __init__(self, old_model: dict[str, Any], full_centroids: sparse.csr_matrix, focus_centroids: sparse.csr_matrix, hasher: Any):
        super().__init__(old_model, full_centroids, hasher)
        self.focus_centroids = focus_centroids
        self.feature_names = (
            [f"full_old_route_margin:{route}" for route in old_model["route"].classes_]
            + [f"focus_old_route_margin:{route}" for route in old_model["route"].classes_]
            + [f"full_route_centroid:{route}" for route in ROUTES]
            + [f"focus_route_centroid:{route}" for route in ROUTES]
            + STRUCTURAL_NAMES
            + ["old_authority_margin", "old_context_margin", "old_activity_margin", "old_compound_margin", "old_route_gap", "old_route_entropy_proxy"]
        )

    def transform(self, rows: Sequence[Any]) -> np.ndarray:
        if not rows:
            return np.empty((0, len(self.feature_names)), dtype=np.float32)
        full_margin, auxiliary = _old_features(self.old_model, rows)
        focus_rows = [RouterInput(focus_text(str(row.request))) for row in rows]
        focus_margin, _ = _old_features(self.old_model, focus_rows)
        full_hashed = self.hasher.transform([str(row.request) for row in rows])
        focus_hashed = self.hasher.transform([focus_text(str(row.request)) for row in rows])
        full_similarities = (full_hashed @ self.centroids.T).toarray().astype(np.float32)
        focus_similarities = (focus_hashed @ self.focus_centroids.T).toarray().astype(np.float32)
        structure = np.vstack([structural_features(row) for row in rows]).astype(np.float32)
        ordered = np.sort(full_margin, axis=1)
        gap = (ordered[:, -1] - ordered[:, -2])[:, None]
        exponent = np.exp(full_margin - full_margin.max(axis=1, keepdims=True))
        probability = exponent / exponent.sum(axis=1, keepdims=True)
        entropy = (-np.sum(probability * np.log(np.maximum(probability, 1e-8)), axis=1))[:, None]
        return np.hstack([
            full_margin, focus_margin, full_similarities, focus_similarities, structure,
            auxiliary["authority"], auxiliary["context"], auxiliary["active"], auxiliary["compound"],
            gap, entropy,
        ]).astype(np.float32)
