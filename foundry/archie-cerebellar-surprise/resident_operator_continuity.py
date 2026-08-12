#!/usr/bin/env python3
"""Keep resident objective/action continuity below the semantic renderer.

The local transcript exposed two coupled failures:
  1. semantic identity regresses toward a generic assistant under pressure;
  2. repeated no-progress conversational actions can loop.

This adapter deliberately does *not* add another E/I memory. It reuses the
existing HomeostaticSurpriseMemory as the consequence model. Semantic text is
non-authoritative: the renderer may explain or propose, but durable objective
state chooses the operator. Surprise is also non-authoritative: value/progress
wins. The scheduling rule is:

  progress > 0                       -> continue operator/objective
  no progress + familiar consequence -> motor-babble alternative
  no progress + surprising outcome   -> inspect/learn consequence first

Thus the cerebellar-inspired lesson survives as a cheap scheduling principle
without duplicating dynamic state or pretending novelty is utility.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any, Sequence


HERE = Path(__file__).resolve().parent
HOMEOSTATIC_PATH = HERE.parent / "archie-action-latent" / "homeostatic_surprise_memory.py"
SCHEMA = "archie/resident-operator-continuity-v1"


def load_homeostatic_module():
    spec = importlib.util.spec_from_file_location(
        "archie_homeostatic_surprise_for_resident_continuity", HOMEOSTATIC_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {HOMEOSTATIC_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@dataclass
class ObjectiveState:
    objective_id: str
    operator_plan: tuple[str, ...]
    cursor: int = 0
    completed: bool = False

    def next_operator(self) -> str | None:
        if self.completed or self.cursor >= len(self.operator_plan):
            return None
        return self.operator_plan[self.cursor]

    def record_progress(self, progress_delta: float) -> None:
        if progress_delta <= 0.0 or self.completed:
            return
        self.cursor += 1
        if self.cursor >= len(self.operator_plan):
            self.completed = True


class SurpriseProgressAdapter:
    """Stateless policy wrapper over the already-existing consequence memory."""

    def __init__(self, memory, *, familiar_novelty_max: float = 0.15, repeat_limit: int = 2):
        self.memory = memory
        self.familiar_novelty_max = float(familiar_novelty_max)
        self.repeat_limit = int(repeat_limit)
        if not 0.0 <= self.familiar_novelty_max <= 1.0:
            raise ValueError("familiar_novelty_max must be in [0,1]")
        if self.repeat_limit < 1:
            raise ValueError("repeat_limit must be >=1")

    @property
    def added_dynamic_trace_count(self) -> int:
        # Thresholds are immutable policy configuration. All learned dynamic
        # state lives in the existing HomeostaticSurpriseMemory instance.
        return 0

    def observe(
        self,
        key: Sequence[float],
        consequence: Sequence[float],
        *,
        objective_progress_delta: float,
        semantic_repeat_count: int,
    ) -> dict[str, Any]:
        receipt = self.memory.observe(key, consequence)
        novelty = float(receipt["novelty_gate"])
        productive = objective_progress_delta > 0.0
        repeated = semantic_repeat_count >= self.repeat_limit

        if productive:
            decision = "continue_objective"
        elif repeated and novelty <= self.familiar_novelty_max:
            decision = "motor_babble_alternative"
        elif novelty > self.familiar_novelty_max:
            decision = "inspect_or_learn_consequence"
        else:
            decision = "retry_once"

        return {
            **receipt,
            "decision": decision,
            "objective_progress_delta": float(objective_progress_delta),
            "semantic_repeat_count": int(semantic_repeat_count),
            "principles": [
                "semantic_renderer_is_non_authoritative",
                "novelty_is_evidence_not_utility",
                "reuse_existing_homeostatic_state",
            ],
        }


class ResidentOperatorKernel:
    """Durable operator cursor plus existing consequence memory.

    Renderer output is accepted only as diagnostic metadata and is never read
    by `next_operator` or `record_consequence` when deciding objective state.
    """

    def __init__(self, objective: ObjectiveState, memory, adapter: SurpriseProgressAdapter | None = None):
        self.objective = objective
        self.memory = memory
        self.adapter = adapter or SurpriseProgressAdapter(memory)

    def next_operator(self, *, renderer_text: str = "") -> str | None:
        _ = renderer_text  # explicit non-authority boundary
        return self.objective.next_operator()

    def record_consequence(
        self,
        key: Sequence[float],
        consequence: Sequence[float],
        *,
        objective_progress_delta: float,
        semantic_repeat_count: int = 0,
        renderer_text: str = "",
    ) -> dict[str, Any]:
        _ = renderer_text
        receipt = self.adapter.observe(
            key,
            consequence,
            objective_progress_delta=objective_progress_delta,
            semantic_repeat_count=semantic_repeat_count,
        )
        self.objective.record_progress(objective_progress_delta)
        return receipt

    def snapshot(self) -> dict[str, Any]:
        # No renderer text, persona string, or generated prose is persistent
        # authority. The objective/operator cursor survives renderer collapse.
        return {
            "schema": SCHEMA,
            "objective": {
                "objective_id": self.objective.objective_id,
                "operator_plan": list(self.objective.operator_plan),
                "cursor": self.objective.cursor,
                "completed": self.objective.completed,
            },
            "homeostatic_memory": self.memory.snapshot(),
            "policy": {
                "familiar_novelty_max": self.adapter.familiar_novelty_max,
                "repeat_limit": self.adapter.repeat_limit,
                "added_dynamic_trace_count": self.adapter.added_dynamic_trace_count,
            },
        }

    def snapshot_bytes(self) -> bytes:
        return json.dumps(
            self.snapshot(), sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")

    @classmethod
    def from_snapshot_bytes(cls, payload: bytes) -> "ResidentOperatorKernel":
        module = load_homeostatic_module()
        obj = json.loads(payload.decode("utf-8"))
        if obj.get("schema") != SCHEMA:
            raise ValueError("resident snapshot schema mismatch")
        o = obj["objective"]
        objective = ObjectiveState(
            objective_id=str(o["objective_id"]),
            operator_plan=tuple(str(x) for x in o["operator_plan"]),
            cursor=int(o["cursor"]),
            completed=bool(o["completed"]),
        )
        memory = module.HomeostaticSurpriseMemory.from_snapshot(obj["homeostatic_memory"])
        p = obj["policy"]
        adapter = SurpriseProgressAdapter(
            memory,
            familiar_novelty_max=float(p["familiar_novelty_max"]),
            repeat_limit=int(p["repeat_limit"]),
        )
        return cls(objective, memory, adapter)


def make_kernel(objective_id: str = "resident-continue") -> ResidentOperatorKernel:
    module = load_homeostatic_module()
    memory = module.HomeostaticSurpriseMemory(module.MemoryConfig(dim=2))
    objective = ObjectiveState(
        objective_id=objective_id,
        operator_plan=("sense", "transform", "verify", "consolidate"),
    )
    return ResidentOperatorKernel(objective, memory)


def run_continuity_court() -> dict[str, Any]:
    # Semantic collapse court: radically different renderers must not change
    # operator selection or durable objective evolution.
    rich = make_kernel("renderer-invariance")
    generic = make_kernel("renderer-invariance")
    rich_text = [
        "Continue the reversible operator court.",
        "Observed consequence; now verify the inverse.",
        "Evidence is finite; preserve the objective.",
        "Consolidate only after the court passes.",
    ]
    generic_text = [
        "How can I help you today?",
        "It depends on the context.",
        "Would you like to explore this further?",
        "Let me know if you need anything else.",
    ]
    rich_ops: list[str | None] = []
    generic_ops: list[str | None] = []
    for index in range(4):
        rich_ops.append(rich.next_operator(renderer_text=rich_text[index]))
        generic_ops.append(generic.next_operator(renderer_text=generic_text[index]))
        key = [1.0, float(index % 2)]
        consequence = [0.25 * (index + 1), -0.1 * index]
        rich.record_consequence(
            key, consequence, objective_progress_delta=0.25,
            semantic_repeat_count=0, renderer_text=rich_text[index],
        )
        generic.record_consequence(
            key, consequence, objective_progress_delta=0.25,
            semantic_repeat_count=0, renderer_text=generic_text[index],
        )

    renderer_invariant = (
        rich_ops == generic_ops
        and rich.objective.completed
        and generic.objective.completed
        and rich.snapshot_bytes() == generic.snapshot_bytes()
    )

    # Stagnant familiar loop: a no-op consequence is already perfectly
    # predictable, so after two semantic repeats it should trigger alternative
    # motor babbling rather than another generic question.
    stagnant = make_kernel("stagnation")
    first_stall = stagnant.record_consequence(
        [1.0, 0.0], [0.0, 0.0], objective_progress_delta=0.0,
        semantic_repeat_count=1, renderer_text="What interests you?",
    )
    second_stall = stagnant.record_consequence(
        [1.0, 0.0], [0.0, 0.0], objective_progress_delta=0.0,
        semantic_repeat_count=2, renderer_text="What interests you?",
    )

    # Useful repetition is protected even when familiar.
    useful = make_kernel("productive-repeat")
    productive_repeat = useful.record_consequence(
        [1.0, 0.0], [0.0, 0.0], objective_progress_delta=0.2,
        semantic_repeat_count=20, renderer_text="generic renderer",
    )

    # Unexpected no-progress consequence should be inspected/learned, not used
    # as an excuse for random novelty seeking.
    shock = make_kernel("unexpected")
    unexpected = shock.record_consequence(
        [1.0, 0.0], [1.0, -1.0], objective_progress_delta=0.0,
        semantic_repeat_count=2, renderer_text="generic renderer",
    )

    # Restart court: exact objective cursor and consequence memory must survive.
    restarted = make_kernel("restart")
    restarted.record_consequence(
        [1.0, 0.0], [0.5, 0.0], objective_progress_delta=0.2,
        semantic_repeat_count=0,
    )
    payload = restarted.snapshot_bytes()
    restored = ResidentOperatorKernel.from_snapshot_bytes(payload)
    restart_equal = (
        payload == restored.snapshot_bytes()
        and restarted.next_operator(renderer_text="rich")
        == restored.next_operator(renderer_text="default assistant")
    )

    checks = {
        "renderer_fallback_cannot_change_operator_trajectory": renderer_invariant,
        "stagnant_repeat_not_suppressed_too_early": first_stall["decision"] == "retry_once",
        "stagnant_repeat_breaks_by_second_repeat": second_stall["decision"] == "motor_babble_alternative",
        "productive_repetition_preserved": productive_repeat["decision"] == "continue_objective",
        "surprising_no_progress_is_inspected_not_randomized": unexpected["decision"] == "inspect_or_learn_consequence",
        "restart_preserves_objective_and_memory": restart_equal,
        "no_added_ei_dynamic_traces": stagnant.adapter.added_dynamic_trace_count == 0,
        "renderer_text_absent_from_durable_snapshot": b"What interests you?" not in stagnant.snapshot_bytes(),
    }

    return {
        "schema": "archie/resident-operator-continuity-court-v1",
        "pass": all(checks.values()),
        "promotion": "developmental-integration-only",
        "checks": checks,
        "renderer_collapse": {
            "rich_operator_trajectory": rich_ops,
            "generic_operator_trajectory": generic_ops,
            "durable_snapshots_equal": rich.snapshot_bytes() == generic.snapshot_bytes(),
        },
        "stagnation": {
            "first_decision": first_stall["decision"],
            "second_decision": second_stall["decision"],
            "second_novelty_gate": second_stall["novelty_gate"],
        },
        "productive_repeat": productive_repeat["decision"],
        "unexpected_consequence": {
            "decision": unexpected["decision"],
            "novelty_gate": unexpected["novelty_gate"],
        },
        "state_reuse": {
            "existing_memory_schema": stagnant.memory.SCHEMA,
            "added_dynamic_trace_count": stagnant.adapter.added_dynamic_trace_count,
        },
        "architectural_consequence": (
            "Resident identity/continuity should live in durable objective and consequence state below language. "
            "A semantic model may regress, restart, or be swapped without gaining authority to erase the action trajectory."
        ),
        "claim_boundary": (
            "PASS proves this deterministic authority/scheduling composition on a tiny synthetic court. "
            "It does not prove general agency, autonomous goal formation, or learned semantic identity."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_continuity_court()
    text = json.dumps(result, indent=2, sort_keys=True, allow_nan=False)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
