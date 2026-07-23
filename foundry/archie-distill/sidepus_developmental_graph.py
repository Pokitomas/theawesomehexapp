#!/usr/bin/env python3
"""A non-school developmental prerequisite graph for Sidepus pursuit.

The graph is intentionally about learnable invariants and operations rather than academic
subjects. It biases early pursuit toward persistence, geometry, dynamics, intervention,
and executable composition, then unlocks language, social inference, and epistemics as
those prerequisites become useful.
"""
from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

GRAPH_SCHEMA = "sidepus-developmental-prerequisite-graph/v1"


@dataclass(frozen=True)
class Primitive:
    prerequisites: tuple[str, ...]
    priority: float
    family: str


PRIMITIVES: dict[str, Primitive] = {
    "persistence": Primitive((), 1.45, "sensorimotor-foundation"),
    "geometry": Primitive((), 1.35, "sensorimotor-foundation"),
    "compression": Primitive((), 1.00, "representation"),
    "source_separation": Primitive((), 0.85, "epistemic-boundary"),
    "identity_tracking": Primitive(("persistence",), 1.30, "object-world"),
    "dynamics": Primitive(("persistence", "geometry"), 1.35, "object-world"),
    "cross_modal_binding": Primitive(("persistence", "identity_tracking"), 1.00, "object-world"),
    "intervention": Primitive(("dynamics",), 1.30, "control"),
    "causal_direction": Primitive(("dynamics", "intervention"), 1.30, "control"),
    "agency": Primitive(("identity_tracking", "causal_direction"), 0.90, "control"),
    "formal_composition": Primitive(("persistence", "compression"), 1.15, "executable"),
    "debugging": Primitive(("formal_composition", "causal_direction"), 1.15, "executable"),
    "communication": Primitive(("source_separation", "compression"), 0.75, "expression"),
    "social_modeling": Primitive(("identity_tracking", "communication", "agency"), 0.65, "social"),
    "uncertainty_reasoning": Primitive(("source_separation", "causal_direction"), 0.85, "epistemic"),
}


def graph_manifest() -> dict[str, Any]:
    return {
        "schema": GRAPH_SCHEMA,
        "principle": (
            "Sequence experience by prerequisite-sensitive learning progress, not school subjects or semantic prestige."
        ),
        "primitives": {
            name: {
                "prerequisites": list(spec.prerequisites),
                "priority": spec.priority,
                "family": spec.family,
            }
            for name, spec in sorted(PRIMITIVES.items())
        },
    }


def normalize_vector(raw: Mapping[str, Any] | None) -> dict[str, float]:
    if not isinstance(raw, Mapping):
        return {}
    return {
        str(name): max(0.0, min(1.0, float(value)))
        for name, value in raw.items()
        if str(name) in PRIMITIVES
    }


def mastery(stat: Any | None) -> float:
    if stat is None:
        return 0.0
    return max(0.0, min(1.0, float(getattr(stat, "mastery", 0.0))))


def count(stat: Any | None) -> int:
    return max(0, int(getattr(stat, "count", 0))) if stat is not None else 0


def readiness(name: str, stats: Mapping[str, Any]) -> float:
    spec = PRIMITIVES[name]
    if not spec.prerequisites:
        return 1.0
    prerequisite_mastery = min(mastery(stats.get(item)) for item in spec.prerequisites)
    # Always retain a small exploratory path, then unlock smoothly with prerequisite mastery.
    return 0.08 + 0.92 / (1.0 + math.exp(-10.0 * (prerequisite_mastery - 0.35)))


def frontier(name: str, stats: Mapping[str, Any]) -> float:
    current = mastery(stats.get(name))
    # Peak near partial mastery; retain pressure at zero so roots can bootstrap.
    return 0.20 + 3.20 * current * (1.0 - current)


def developmental_drive(
    vector: Mapping[str, Any] | None,
    stats: Mapping[str, Any],
) -> tuple[float, dict[str, float]]:
    normalized = normalize_vector(vector)
    details: dict[str, float] = {}
    total = 0.0
    for name, exposure in normalized.items():
        spec = PRIMITIVES[name]
        ready = readiness(name, stats)
        frontier_value = frontier(name, stats)
        novelty = 1.0 / math.sqrt(count(stats.get(name)) + 1.0)
        value = exposure * spec.priority * ready * (0.72 * frontier_value + 0.28 * novelty)
        details[name] = value
        total += value
    return total, details
