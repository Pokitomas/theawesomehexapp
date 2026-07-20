#!/usr/bin/env python3
"""Train Archie Reasoner with verified Kimi structural supervision.

This bridge leaves the existing reasoner implementation unchanged. It patches the
training target builder before importing the trainer so accepted Kimi fields are
part of the autoregressive task-graph target rather than dead audit metadata.
Every output remains promotion:not-admitted under the reasoner's own receipt.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any, Callable, Mapping

ROOT = Path(__file__).resolve().parents[1]
REASONER_DIR = ROOT / "archie-reasoner"


def _strict_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def _strict_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


def _strict_text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    text = value.strip()
    if len(text) > maximum:
        raise ValueError(f"{name} exceeds {maximum} characters")
    return text


def enrich_target(
    graph: Mapping[str, Any],
    plan: Mapping[str, Any],
    row: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Add verified optional structure to a reasoner target.

    Ordinary corpus rows are unchanged. Distilled rows are recognized by the
    presence of the complete structural field set and fail closed if any value is
    malformed or inconsistent with the source route.
    """
    fields = ("active_clauses", "compound", "operation", "target", "ordered_outcomes")
    present = [name in row for name in fields]
    if not any(present):
        return dict(graph), dict(plan)
    if not all(present):
        missing = [name for name, exists in zip(fields, present) if not exists]
        raise ValueError(f"incomplete Kimi structural supervision: {missing}")

    active_clauses = _strict_int(row["active_clauses"], "active_clauses", 0, 6)
    compound = _strict_bool(row["compound"], "compound")
    requested_route = str(row.get("route") or "")
    if compound != (requested_route == "compound"):
        raise ValueError("compound must exactly match whether the requested route is compound")
    if compound and active_clauses < 2:
        raise ValueError("compound supervision requires at least two active clauses")

    operation = _strict_text(row["operation"], "operation", 160)
    target = _strict_text(row["target"], "target", 240)
    outcomes = row["ordered_outcomes"]
    if not isinstance(outcomes, list) or len(outcomes) > 6:
        raise ValueError("ordered_outcomes must be a list with at most six entries")
    ordered_outcomes = [
        _strict_text(value, f"ordered_outcomes[{index}]", 200)
        for index, value in enumerate(outcomes)
    ]
    if compound and len(ordered_outcomes) < 2:
        raise ValueError("compound supervision requires at least two ordered outcomes")

    enriched_graph = dict(graph)
    enriched_graph.update(
        {
            "requested_route": requested_route,
            "active_clauses": active_clauses,
            "compound": compound,
            "operation": operation,
            "target": target,
        }
    )
    enriched_plan = dict(plan)
    enriched_plan["ordered_outcomes"] = ordered_outcomes
    return enriched_graph, enriched_plan


def install_patch(reasoner_module: Any) -> None:
    original: Callable[[Mapping[str, Any]], tuple[dict[str, Any], dict[str, Any]]] = (
        reasoner_module.target_objects
    )
    if getattr(original, "__archie_kimi_bridge__", False):
        return

    def patched(row: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        graph, plan = original(row)
        return enrich_target(graph, plan, row)

    patched.__archie_kimi_bridge__ = True  # type: ignore[attr-defined]
    patched.__name__ = getattr(original, "__name__", "target_objects")
    patched.__doc__ = "Archie target builder enriched with verified Kimi structure."
    reasoner_module.target_objects = patched


def main() -> int:
    if not REASONER_DIR.is_dir():
        raise RuntimeError(f"missing Archie Reasoner directory: {REASONER_DIR}")
    sys.path.insert(0, str(REASONER_DIR))
    reasoner = importlib.import_module("archie_reasoner")
    install_patch(reasoner)
    trainer = importlib.import_module("train")
    return int(trainer.main())


if __name__ == "__main__":
    raise SystemExit(main())
