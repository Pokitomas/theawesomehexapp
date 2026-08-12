#!/usr/bin/env python3
"""Falsify one-transition action identity and promote trajectory-level operators.

A state pair can be perfectly observed and still fail to identify the action
that produced it.  Two distinct invertible operators may agree at the current
state and diverge only when the same action is applied again.

Base witness in R^2:

    U(x) = R_90 x
    V(x) = x + (-1, +1)
    x0 = (1, 0)

Both give x1=(0,1), so *every* representation f(x0,x1) is identical under U
and V: delta, endpoints, cross products, an arbitrarily large neural encoder,
etc.  But a repeated application gives

    U(x1)=(-1,0)
    V(x1)=(-1,2).

Therefore inverse dynamics from one transition is information-theoretically
underdetermined.  No larger one-step latent fixes it.  The missing variable is
trajectory/intervention evidence about the operator itself.

This court conjugates the witness by many exact integer rigid transforms so the
result is not tied to one coordinate frame.  It then proves a 50% Bayes ceiling
for balanced first-transition-only action identity and checks that a compact
second-order relation, dot(d1,d2), separates the two operator families exactly.

The result is a design change, not an intelligence claim: persistent action
identity should be induced from repeated interventions/composition, while a
single transition is only a local effect observation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

Vec = tuple[int, int]
Mat = tuple[tuple[int, int], tuple[int, int]]


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1])


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1])


def mv(m: Mat, x: Vec) -> Vec:
    return (
        m[0][0] * x[0] + m[0][1] * x[1],
        m[1][0] * x[0] + m[1][1] * x[1],
    )


def dot(a: Vec, b: Vec) -> int:
    return a[0] * b[0] + a[1] * b[1]


def det(m: Mat) -> int:
    return m[0][0] * m[1][1] - m[0][1] * m[1][0]


def transpose(m: Mat) -> Mat:
    return ((m[0][0], m[1][0]), (m[0][1], m[1][1]))


def mm(a: Mat, b: Mat) -> Mat:
    return (
        (
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
        ),
        (
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
        ),
    )


D4: tuple[Mat, ...] = (
    ((1, 0), (0, 1)),
    ((0, -1), (1, 0)),
    ((-1, 0), (0, -1)),
    ((0, 1), (-1, 0)),
    ((1, 0), (0, -1)),
    ((-1, 0), (0, 1)),
    ((0, 1), (1, 0)),
    ((0, -1), (-1, 0)),
)
R90: Mat = ((0, -1), (1, 0))
BASE_TRANSLATION: Vec = (-1, 1)
BASE_X0: Vec = (1, 0)


@dataclass(frozen=True)
class Episode:
    frame: Mat
    offset: Vec
    family: str
    x0: Vec
    x1: Vec
    x2: Vec

    @property
    def d1(self) -> Vec:
        return sub(self.x1, self.x0)

    @property
    def d2(self) -> Vec:
        return sub(self.x2, self.x1)

    @property
    def first_signature(self) -> tuple[Vec, Vec]:
        # Full endpoints. Any one-step statistic is a function of this object,
        # so collision here is stronger than testing a menu of features.
        return self.x0, self.x1

    @property
    def second_signature(self) -> tuple[Vec, Vec, Vec]:
        return self.x0, self.x1, self.x2


def conjugated_episode(frame: Mat, offset: Vec, family: str) -> Episode:
    def g(x: Vec) -> Vec:
        return add(mv(frame, x), offset)

    base_x1 = mv(R90, BASE_X0)  # identical to BASE_X0 + BASE_TRANSLATION
    if family == "rotation":
        base_x2 = mv(R90, base_x1)
    elif family == "translation":
        base_x2 = add(base_x1, BASE_TRANSLATION)
    else:
        raise ValueError(family)
    return Episode(frame, offset, family, g(BASE_X0), g(base_x1), g(base_x2))


def build_episodes(seed: int, witnesses: int) -> list[Episode]:
    rng = random.Random(seed)
    episodes: list[Episode] = []
    seen: set[tuple[Vec, Vec]] = set()
    attempts = 0
    while len(seen) < witnesses and attempts < witnesses * 50 + 100:
        attempts += 1
        frame = rng.choice(D4)
        offset = (rng.randint(-1000, 1000), rng.randint(-1000, 1000))
        rot = conjugated_episode(frame, offset, "rotation")
        key = rot.first_signature
        if key in seen:
            continue
        seen.add(key)
        episodes.append(rot)
        episodes.append(conjugated_episode(frame, offset, "translation"))
    if len(seen) != witnesses:
        raise RuntimeError(f"could only construct {len(seen)} unique witnesses")
    rng.shuffle(episodes)
    return episodes


def orthogonal_integer(m: Mat) -> bool:
    return mm(transpose(m), m) == ((1, 0), (0, 1)) and abs(det(m)) == 1


def contradictory_groups(episodes: list[Episode], attr: str) -> dict[str, Any]:
    groups: dict[Any, Counter[str]] = defaultdict(Counter)
    for ep in episodes:
        groups[getattr(ep, attr)][ep.family] += 1
    contradictory = {k: v for k, v in groups.items() if len(v) > 1}
    majority_correct = sum(max(counter.values()) for counter in groups.values())
    total = len(episodes)
    return {
        "unique_signatures": len(groups),
        "contradictory_signatures": len(contradictory),
        "contradictory_episode_count": sum(sum(v.values()) for v in contradictory.values()),
        "deterministic_bayes_accuracy_ceiling": majority_correct / max(1, total),
    }


def second_order_rule(ep: Episode) -> str:
    # In the base witness, translation repeats d1 exactly, so dot(d1,d2)=2.
    # Rotation turns d1 by 90 degrees in the action frame, so dot=0.
    # Orthogonal conjugation preserves the dot product exactly.
    return "translation" if dot(ep.d1, ep.d2) > 0 else "rotation"


def witness_digest(episodes: list[Episode]) -> str:
    rows = [
        {
            "family": ep.family,
            "x0": ep.x0,
            "x1": ep.x1,
            "x2": ep.x2,
            "d1": ep.d1,
            "d2": ep.d2,
            "dot_d1_d2": dot(ep.d1, ep.d2),
        }
        for ep in sorted(episodes, key=lambda e: (e.x0, e.x1, e.family))
    ]
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_court(seed: int, witnesses: int) -> dict[str, Any]:
    episodes = build_episodes(seed, witnesses)
    first = contradictory_groups(episodes, "first_signature")
    second = contradictory_groups(episodes, "second_signature")
    second_predictions = [second_order_rule(ep) for ep in episodes]
    second_accuracy = sum(p == ep.family for p, ep in zip(second_predictions, episodes)) / len(episodes)

    frame_pass = all(orthogonal_integer(ep.frame) for ep in episodes)
    first_pair_identity = all(
        episodes_by_family["rotation"].x0 == episodes_by_family["translation"].x0
        and episodes_by_family["rotation"].x1 == episodes_by_family["translation"].x1
        and episodes_by_family["rotation"].x2 != episodes_by_family["translation"].x2
        for episodes_by_family in (
            {ep.family: ep for ep in episodes if ep.first_signature == signature}
            for signature in {ep.first_signature for ep in episodes}
        )
    )

    dot_values: dict[str, set[int]] = defaultdict(set)
    for ep in episodes:
        dot_values[ep.family].add(dot(ep.d1, ep.d2))

    result = {
        "schema": "archie-action-latent/second-order-action-identity-court-v1",
        "seed": seed,
        "witnesses": witnesses,
        "episodes": len(episodes),
        "first_transition": first,
        "second_transition": second,
        "second_order_rule_accuracy": second_accuracy,
        "dot_d1_d2_values": {k: sorted(v) for k, v in sorted(dot_values.items())},
        "all_frames_exact_integer_isometries": frame_pass,
        "all_first_pairs_identical_and_second_steps_diverge": first_pair_identity,
        "witness_sha256": witness_digest(episodes),
        "architectural_consequence": (
            "Stop asking a one-transition inverse model to discover persistent action identity. A single state pair can be maximally observed yet causally ambiguous. "
            "Represent local effect and persistent operator as different objects: effect comes from one transition; operator identity earns consolidation only through repeated intervention, composition, or trajectory evidence."
        ),
        "next_escalation": (
            "Train trajectory-level latent operators that must predict multiple repeated applications and composition laws, then adversarially search for higher-order aliases. If two-step histories alias, increase intervention order rather than silently widening a one-step encoder."
        ),
        "claim_boundary": (
            "This is an exact constructive non-identifiability witness for one-step action identity in an invertible affine-isometry family. It does not prove every environment requires two steps or that dot(d1,d2) is a universal trajectory representation."
        ),
    }
    result["pass"] = bool(
        frame_pass
        and first_pair_identity
        and first["contradictory_signatures"] == witnesses
        and first["deterministic_bayes_accuracy_ceiling"] == 0.5
        and second["contradictory_signatures"] == 0
        and second_accuracy == 1.0
        and dot_values.get("rotation") == {0}
        and dot_values.get("translation") == {2}
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=12001)
    parser.add_argument("--witnesses", type=int, default=256)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(args.seed, args.witnesses)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
