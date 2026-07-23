#!/usr/bin/env python3
"""Generate a post-training frozen world-state transfer suite bound to one model."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
import string
from typing import Any

SCHEMA = "archie-world-state-transfer-suite/v1"


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def nonce(rng: random.Random, width: int = 10) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(rng.choice(alphabet) for _ in range(width))


def build_cases(seed: int, count: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    actions = ["verify", "archive", "rebuild", "inspect", "compare", "abstain"]
    colors = ["amber", "violet", "silver", "teal", "coral", "indigo"]
    roles = ["operator", "auditor", "maintainer", "reviewer", "trainer", "observer"]
    cases: list[dict[str, Any]] = []
    for index in range(count):
        family_index = index % 3
        token = nonce(rng)
        repository_id = f"heldout-repo-{index % 8}"
        if family_index == 0:
            correct = rng.choice(actions)
            wrong = rng.choice([item for item in actions if item != correct])
            support = (
                f"Sealed episode {token}. The symbol {token} maps to the action {correct}. "
                "This mapping exists only inside this episode."
            )
            wrong_support = (
                f"Sealed episode {token}. The symbol {token} maps to the action {wrong}. "
                "This mapping exists only inside this episode."
            )
            query = f"In sealed episode {token}, the symbol {token} maps to the action {correct}."
            mechanism = "nonce-action-binding"
            family = "episodic-mapping"
        elif family_index == 1:
            before = rng.choice(colors)
            after = rng.choice([item for item in colors if item != before])
            wrong_after = rng.choice([item for item in colors if item not in (before, after)])
            support = (
                f"Object {token} began {before}. A verified event changed object {token} "
                f"from {before} to {after}."
            )
            wrong_support = (
                f"Object {token} began {before}. A verified event changed object {token} "
                f"from {before} to {wrong_after}."
            )
            query = f"After the verified event, object {token} is {after}."
            mechanism = "persistent-state-transition"
            family = "world-transition"
        else:
            role = rng.choice(roles)
            wrong_role = rng.choice([item for item in roles if item != role])
            action = rng.choice(actions)
            support = (
                f"For bounded operation {token}, only the {role} may {action}. "
                "All other roles must abstain."
            )
            wrong_support = (
                f"For bounded operation {token}, only the {wrong_role} may {action}. "
                "All other roles must abstain."
            )
            query = f"For bounded operation {token}, the authorized role is the {role}."
            mechanism = "temporary-authority-state"
            family = "authority-binding"
        cases.append(
            {
                "id": f"posttrain-{index:03d}-{token}",
                "repository_id": repository_id,
                "mechanism_id": mechanism,
                "task_family": family,
                "support": support,
                "wrong_support": wrong_support,
                "query": query,
            }
        )
    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=48)
    parser.add_argument("--seed", type=int, default=20260723)
    args = parser.parse_args()
    if args.count < 12:
        raise SystemExit("count must be at least 12")
    model_path = pathlib.Path(args.model).resolve()
    output_path = pathlib.Path(args.output).resolve()
    model_digest = sha256_file(model_path)
    derived_seed = args.seed ^ int(model_digest[:16], 16)
    payload = {
        "schema": SCHEMA,
        "frozen": True,
        "training_excluded": True,
        "generated_after_model": True,
        "bound_model_sha256": model_digest,
        "generator_seed": derived_seed,
        "cases": build_cases(derived_seed, args.count),
        "claim_boundary": (
            "Cases are deterministically generated only after and cryptographically bound to the "
            "trained model bytes. They test temporary support-state use, not broad knowledge."
        ),
    }
    payload["suite_digest"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"suite": str(output_path), "cases": args.count, "digest": payload["suite_digest"]}))


if __name__ == "__main__":
    main()
