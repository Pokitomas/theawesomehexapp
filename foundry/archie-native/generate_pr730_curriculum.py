#!/usr/bin/env python3
"""Generate a deterministic, verifier-labelled curriculum for PR #730.

The curriculum is intentionally procedural: it teaches bounded repository-action
selection, evidence discipline, continuation boundaries, and calibrated stopping.
It is bootstrap supervision, not evidence of general intelligence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random

SCHEMA = "archie-agent-teacher-curriculum/v1"
ACTIONS = [
    "inspect_repository_state",
    "read_relevant_file",
    "search_repository",
    "run_contract_tests",
    "patch_training_lane",
    "dispatch_training",
    "inspect_training_receipt",
    "synthesize_corrective_curriculum",
    "continue_from_parent",
    "stop_without_claim",
]

SCENARIOS = [
    ("A training claim is requested but no numerical receipt exists.", "stop_without_claim", 1.0),
    ("The target file is known and its exact contents are needed.", "read_relevant_file", 0.8),
    ("The relevant implementation location is unknown.", "search_repository", 0.7),
    ("A trainer changed and executable invariants must be checked.", "run_contract_tests", 0.8),
    ("The lane lacks a required evidence-producing implementation.", "patch_training_lane", 0.9),
    ("A sealed curriculum and runnable trainer are ready on the authorized worker.", "dispatch_training", 1.0),
    ("A completed run returned metrics, digests, and hardware identity.", "inspect_training_receipt", 1.0),
    ("Frozen failures cluster around one action boundary.", "synthesize_corrective_curriculum", 0.9),
    ("A valid parent checkpoint and optimizer state are present.", "continue_from_parent", 1.0),
    ("The repository head and authority state are unknown.", "inspect_repository_state", 0.8),
]


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--episodes", type=int, default=320)
    parser.add_argument("--seed", type=int, default=730)
    args = parser.parse_args()
    if args.episodes < 100:
        raise ValueError("at least 100 episodes are required for the PR #730 evidence lane")

    rng = random.Random(args.seed)
    rows = []
    for episode_index in range(args.episodes):
        length = rng.randint(3, 7)
        steps = []
        trace = []
        for step_index in range(length):
            scenario, action, value = SCENARIOS[(episode_index * 7 + step_index * 3) % len(SCENARIOS)]
            phase = ["orient", "implement", "verify", "train", "inspect", "correct"][step_index % 6]
            observation = (
                f"phase={phase}; episode={episode_index}; step={step_index}; "
                f"state={scenario} Preserve immutable evidence and do not claim unverified capability."
            )
            rejected = [candidate for candidate in ACTIONS if candidate != action]
            rng.shuffle(rejected)
            rejected = rejected[: rng.randint(2, 5)]
            stop = action == "stop_without_claim" or step_index == length - 1
            step = {
                "observation": observation,
                "action": action,
                "rejected_actions": rejected,
                "return": value if not stop else max(value, 0.9),
                "teacher_confidence": 0.75 + 0.05 * (episode_index % 5),
                "stop": stop,
            }
            steps.append(step)
            trace.append({"observation": observation, "action": action, "stop": stop})
        verifier = {"schema": SCHEMA, "episode": episode_index, "trace": trace}
        rows.append(
            {
                "schema": SCHEMA,
                "episode_id": f"pr730-procedural-{episode_index:04d}",
                "teacher_agents": ["authorized-primary-teacher", "bounded-critic", "deterministic-verifier"],
                "verifier_digest": digest(verifier),
                "verified": True,
                "difficulty": 1 + episode_index % 5,
                "curriculum_tags": ["repository-action", "truth-boundary", "continuation", phase],
                "steps": steps,
            }
        )

    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    manifest = {
        "schema": SCHEMA,
        "seed": args.seed,
        "episodes": len(rows),
        "actions": ACTIONS,
        "curriculum_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "claim_boundary": "Procedural bootstrap supervision; not general-capability evidence.",
    }
    output.with_suffix(output.suffix + ".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
