#!/usr/bin/env python3
"""Behavior-only entrypoint for the developmental teacher-escape court.

The underlying research module exposes diagnostic probes, but experiment one does
not use hidden-rule labels as training or admission evidence. Only externally
observable competence and post-teacher improvement determine the verdict.
"""
from __future__ import annotations

import archie_developmental_teacher_escape as experiment


def behavioral_aggregate(cfg: experiment.Config, runs: list[dict]) -> dict:
    checks = {
        "continues_learning_after_teacher": min(
            run["autonomous_seen_gain"] for run in runs
        ) > 0.03,
        "escapes_teacher_family_boundary": min(
            run["autonomous_transfer_gain"] for run in runs
        ) > 0.08,
        "transfer_is_nontrivial": min(
            run["final"]["transfer_accuracy"] for run in runs
        ) > (1.0 / experiment.PRIME) + 0.18,
        "teacher_is_absent_during_gain": all(
            len(run["trajectory"]) == cfg.autonomous_rounds + 1 for run in runs
        ),
    }
    return {
        "schema": experiment.SCHEMA,
        "config": experiment.asdict(cfg),
        "runs": runs,
        "checks": checks,
        "passed_declared_experiment": all(checks.values()),
        "claim_boundary": (
            "Pass means a locally trainable student improved after bounded teacher access ended "
            "and acquired competence on relational families absent from the teacher curriculum. "
            "No hidden rule labels, API weight access, or persistent teacher calls contribute to "
            "the verdict. This remains a bounded developmental-world result."
        ),
    }


experiment.aggregate = behavioral_aggregate


if __name__ == "__main__":
    experiment.main()
