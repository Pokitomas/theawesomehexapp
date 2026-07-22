#!/usr/bin/env python3
"""Fail-closed evidence checks for the regenerative growth authority boundary."""
from __future__ import annotations

import json

from archie_regenerative_governor import (
    distinct_failed_attempts,
    explicit_plateau,
    normalize_diagnosis,
)


def main() -> None:
    one_bad_run = {
        "status": "rejected",
        "gates": {
            "capability": {"passed": False},
            "retention": {"passed": False},
            "replication": {"passed": False},
        },
    }
    assert distinct_failed_attempts(one_bad_run) == 0
    assert explicit_plateau(one_bad_run) is None
    try:
        normalize_diagnosis(one_bad_run, forced=False)
    except ValueError:
        pass
    else:
        raise AssertionError("arbitrary failed gates authorized growth")

    repeated = {
        "attempts": [
            {"kind": "curriculum", "status": "rejected"},
            {"kind": "curriculum", "status": "rejected"},
            {"kind": "objective", "passed": False},
            {"kind": "merge", "status": "failed"},
        ],
        "plateau_relative_gain": 0.001,
    }
    normalized = normalize_diagnosis(repeated, forced=False)
    assert normalized["failed_interventions"] == 3
    assert normalized["plateau_relative_gain"] == 0.001

    explicit = normalize_diagnosis(
        {"failed_interventions": 4, "recent_relative_gain": 0.0005},
        forced=False,
    )
    assert explicit["failed_interventions"] == 4
    assert explicit["plateau_relative_gain"] == 0.0005

    print(json.dumps({
        "schema": "archie-regenerative-governor-test/v1",
        "single_run_gate_count": distinct_failed_attempts(one_bad_run),
        "distinct_rejected_interventions": normalized["failed_interventions"],
        "plateau_required": True,
        "forced_override_is_explicit": normalize_diagnosis(None, forced=True) == {},
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
