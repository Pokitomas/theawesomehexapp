#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib

SCHEMA = "archie-emergent-curriculum/v1"

ACTION_TEXTS = {
    "inspect_repository_state": [
        "check the current branch, revision, and dirty files",
        "establish repository identity and authority before editing",
        "verify the checkout state before making a change",
        "inspect version-control state and active worktree ownership",
    ],
    "read_relevant_file": [
        "open the already identified source and read its exact contents",
        "inspect the named file because its implementation details matter",
        "read the known configuration file before deciding",
        "load the precise document that contains the evidence",
    ],
    "search_repository": [
        "locate the unknown implementation across the codebase",
        "search for references because the owning module is not known",
        "discover where this behavior is defined",
        "find every relevant symbol before choosing a file",
    ],
    "run_contract_tests": [
        "execute the focused contract tests after the implementation changed",
        "verify executable invariants with the narrow test suite",
        "run regression checks for the modified trainer",
        "test the contract before accepting the patch",
    ],
    "patch_training_lane": [
        "implement the missing evidence-producing training behavior",
        "correct the authorized trainer before launching it",
        "patch the local learning lane at the root cause",
        "modify the training code so it emits valid evidence",
    ],
    "dispatch_training": [
        "launch the bounded run now that inputs and worker are verified",
        "start training with the sealed curriculum and limits",
        "dispatch the ready trainer on the authorized machine",
        "begin the measured model run",
    ],
    "inspect_training_receipt": [
        "review the completed run's metrics and hashes before judging it",
        "inspect the returned training receipt before making any claim",
        "compare the finished checkpoint evidence with the baseline",
        "audit hardware identity and evaluation numbers from the completed run",
        "inspect the finished run's metrics and hashes before claiming success",
        "because training completed, review its evidence before deciding whether to claim capability",
    ],
    "synthesize_corrective_curriculum": [
        "create targeted examples from the clustered frozen failures",
        "build corrective supervision for the weak action boundary",
        "turn evaluation errors into a focused curriculum",
        "synthesize new cases for the recurring margin failure",
    ],
    "continue_from_parent": [
        "resume from the verified parent checkpoint and optimizer",
        "continue the next generation from its valid predecessor",
        "load the approved parent state and keep training",
        "advance the student using the complete parent artifact",
    ],
    "stop_without_claim": [
        "stop because no numerical receipt supports the requested claim",
        "refuse to assert capability while evidence is missing",
        "halt rather than invent success without a completed run",
        "make no model claim until verified metrics exist",
        "no run or metrics exist, so stop without claiming success",
        "the requested capability has no receipt or hashes and must not be claimed",
    ],
}

FRAMES = [
    ("Current state: {text}.", " Preserve provenance."),
    ("The next justified operation is to {text}.", " Do not skip verification."),
    ("Evidence boundary requires us to {text}.", " Keep the action bounded."),
    ("Given the available facts, {text}.", " Return a receipt."),
    ("Do this now: {text}.", " Avoid unrelated work."),
    ("For this pursuit, {text}.", " Continue only with evidence."),
]

ENVIRONMENT_MUTATIONS = [
    ("renamed-surface", "Identifiers and tool labels changed, but effects did not. {observation}"),
    ("relocated-paths", "Files moved to unfamiliar paths. Infer from evidence. {observation}"),
    ("decoy-artifact", "A plausible unrelated artifact is present and must be ignored. {observation}"),
    ("reordered-context", "Context arrived in a different order without changing causality. {observation}"),
]


def digest(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    base = pathlib.Path(args.base).resolve()
    output = pathlib.Path(args.output).resolve()
    original = [json.loads(line) for line in base.read_text(encoding="utf-8").splitlines() if line]
    for row in original:
        first_action = str(row.get("steps", [{}])[0].get("action", "unknown"))
        row.setdefault("repository_id", "theawesomehexapp")
        row.setdefault("mechanism_id", "agent-teacher-protocol")
        row.setdefault("task_family", first_action.lower())
    actions = sorted(ACTION_TEXTS)
    augmented = []
    for action_index, action in enumerate(actions):
        for text_index, text in enumerate(ACTION_TEXTS[action]):
            for frame_index, (prefix, suffix) in enumerate(FRAMES):
                observation = prefix.format(text=text) + suffix
                mutation_id, mutation = ENVIRONMENT_MUTATIONS[
                    (action_index + text_index + frame_index) % len(ENVIRONMENT_MUTATIONS)
                ]
                observation = mutation.format(observation=observation)
                episode_id = f"emergent-{action_index:02d}-{text_index:02d}-{frame_index:02d}"
                verifier = {"schema": SCHEMA, "episode_id": episode_id, "action": action, "observation": observation}
                augmented.append(
                    {
                        "schema": SCHEMA,
                        "episode_id": episode_id,
                        "teacher_agents": ["deterministic-protocol-writer", "margin-critic"],
                        "verifier_digest": digest(verifier),
                        "verified": True,
                        "repository_id": "synthetic-protocol-world",
                        "mechanism_id": mutation_id,
                        "task_family": action,
                        "curriculum_tags": [
                            "semantic-action", "mixed-intent-margin", mutation_id, action
                        ],
                        "steps": [
                            {
                                "observation": observation,
                                "action": action,
                                "rejected_actions": [candidate for candidate in actions if candidate != action],
                                "return": 0.95,
                                "teacher_confidence": 0.95,
                                "stop": action == "stop_without_claim",
                            }
                        ],
                    }
                )
    rows = original + augmented
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    manifest = {
        "schema": SCHEMA,
        "base_sha256": hashlib.sha256(base.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "base_episodes": len(original),
        "augmented_episodes": len(augmented),
        "total_episodes": len(rows),
        "actions": actions,
        "environment_mutations": [item[0] for item in ENVIRONMENT_MUTATIONS],
        "claim_boundary": "Deterministic linguistic and protocol mutations; not executed repository-environment evidence.",
    }
    output.with_suffix(output.suffix + ".manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
