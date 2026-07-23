#!/usr/bin/env python3
"""Generate a rights-clean deterministic developmental corpus for Sidepus.

This is not a claim of human-like childhood. It supplies executable, empirical, communicative,
social, and uncertainty-bearing episode threads so the pursuit controller is not forced to
train almost entirely on archive text plus microphysics. Model-visible payloads contain only
observations, utterances, and action/consequence bytes; generator truth is stored in hidden
channels for evaluation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import random
import tempfile
from collections import Counter
from typing import Any

INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
RECEIPT_SCHEMA = "sidepus-developmental-corpus-receipt/v1"
HOST = "developmental.procedural.sidepus.invalid"
DOMAINS = (
    "formal_executable",
    "empirical_world",
    "language_expression",
    "social_institutional",
    "adversarial_messy",
)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def atomic_bytes(path: pathlib.Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != payload:
            raise RuntimeError(f"content-addressed object collision: {path}")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        tmp = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def put_object(state_dir: pathlib.Path, payload: bytes) -> str:
    digest = hashlib.sha256(payload).hexdigest()
    atomic_bytes(state_dir / "objects" / "sha256" / digest[:2] / digest[2:], payload)
    return digest


def executable_episode(rng: random.Random, steps: int) -> list[tuple[bytes, bytes, dict[str, Any]]]:
    value = rng.randrange(256)
    rows = []
    for index in range(steps):
        opcode = rng.randrange(6)
        argument = rng.randrange(1, 32)
        before = value
        if opcode == 0: value = (value + argument) & 255
        elif opcode == 1: value = (value - argument) & 255
        elif opcode == 2: value ^= argument
        elif opcode == 3: value = ((value << 1) | (value >> 7)) & 255
        elif opcode == 4: value = ((value >> 1) | ((value & 1) << 7)) & 255
        else: value = (value * argument) & 255
        observation = bytes((index & 255, before, opcode, argument))
        consequence = bytes((value, int(value == 0), (before ^ value) & 255))
        rows.append((observation, consequence, {"before": before, "opcode": opcode, "argument": argument, "after": value}))
    return rows


def empirical_episode(rng: random.Random, steps: int) -> list[tuple[bytes, bytes, dict[str, Any]]]:
    latent = rng.randrange(32, 224)
    velocity = rng.choice((-3, -2, -1, 1, 2, 3))
    rows = []
    for index in range(steps):
        intervention = rng.choice((-2, -1, 0, 0, 0, 1, 2))
        noisy = max(0, min(255, latent + rng.choice((-2, -1, 0, 0, 0, 1, 2))))
        before = latent
        velocity = max(-8, min(8, velocity + intervention))
        latent += velocity
        if latent < 0 or latent > 255:
            latent = max(0, min(255, latent)); velocity *= -1
        rows.append((bytes((index & 255, noisy, (velocity + 128) & 255)), bytes(((intervention + 128) & 255, latent & 255)), {"latent_before": before, "latent_after": latent, "velocity": velocity, "intervention": intervention}))
    return rows


def language_episode(rng: random.Random, steps: int) -> list[tuple[bytes, bytes, dict[str, Any]]]:
    subjects = ("red key", "small orb", "north gate", "quiet signal")
    verbs = ("moves", "opens", "follows", "changes")
    object_name = rng.choice(subjects)
    rows = []
    for index in range(steps):
        fact = f"{object_name} {rng.choice(verbs)} at step {index}.".encode()
        request = f"report step {index} and preserve {object_name}".encode()
        rows.append((fact, request, {"referent": object_name, "step": index, "continuity_required": True}))
    return rows


def social_episode(rng: random.Random, steps: int) -> list[tuple[bytes, bytes, dict[str, Any]]]:
    trust = [rng.randrange(64, 192), rng.randrange(64, 192)]
    resource = rng.randrange(80, 176)
    rows = []
    for index in range(steps):
        actor = index % 2
        offer = rng.randrange(0, min(64, resource) + 1)
        accept = int(offer * 2 + trust[1 - actor] >= 128)
        if accept:
            resource = max(0, resource - offer)
            trust[actor] = min(255, trust[actor] + offer // 4 + 1)
        else:
            trust[actor] = max(0, trust[actor] - 5)
        observation = bytes((actor, offer, resource, trust[0], trust[1]))
        consequence = bytes((accept, resource, trust[actor]))
        rows.append((observation, consequence, {"actor": actor, "offer": offer, "accepted": bool(accept), "trust": list(trust), "resource": resource}))
    return rows


def messy_episode(rng: random.Random, steps: int) -> list[tuple[bytes, bytes, dict[str, Any]]]:
    latent = rng.randrange(256)
    rows = []
    for index in range(steps):
        reliable = rng.random() > 0.35
        claim = latent if reliable else rng.randrange(256)
        source = rng.randrange(4)
        confidence = rng.randrange(32, 256)
        if rng.random() < 0.25:
            latent = (latent + rng.choice((-7, -3, 3, 7))) & 255
        observation = bytes((source, claim, confidence, index & 255))
        consequence = bytes((latent, int(reliable)))
        rows.append((observation, consequence, {"latent": latent, "claim_reliable": reliable, "source": source}))
    return rows


GENERATORS = {
    "formal_executable": executable_episode,
    "empirical_world": empirical_episode,
    "language_expression": language_episode,
    "social_institutional": social_episode,
    "adversarial_messy": messy_episode,
}


def generate(state_dir: pathlib.Path, output: pathlib.Path, episodes_per_domain: int, steps: int, seed: int) -> dict[str, Any]:
    if episodes_per_domain < 1 or steps < 2:
        raise ValueError("episodes_per_domain must be positive and steps must be >= 2")
    state_dir, output = state_dir.expanduser().resolve(), output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    counts = Counter()
    for domain_index, domain in enumerate(DOMAINS):
        for episode in range(episodes_per_domain):
            episode_seed = seed + domain_index * 1_000_003 + episode * 104_729
            sequence_id = f"developmental:{domain}:{seed}:{episode:08d}"
            generated = GENERATORS[domain](random.Random(episode_seed), steps)
            for index, (observation, consequence, truth) in enumerate(generated):
                observation_sha = put_object(state_dir, observation)
                consequence_sha = put_object(state_dir, consequence)
                hidden_payload = (stable_json({"schema": "sidepus-developmental-hidden-truth/v1", "domain": domain, "sequence_id": sequence_id, "sequence_index": index, "truth": truth}) + "\n").encode()
                hidden_sha = put_object(state_dir, hidden_payload)
                flags = ["contradictory"] if domain == "adversarial_messy" else []
                medium = "text" if domain == "language_expression" else "application"
                rows.append({
                    "schema": INVENTORY_SCHEMA,
                    "record_id": "dev_" + hashlib.sha256(f"{sequence_id}:{index}".encode()).hexdigest()[:32],
                    "object_sha256": observation_sha,
                    "bytes": len(observation) + len(consequence),
                    "estimated_tokens": len(observation) + len(consequence),
                    "domain": domain,
                    "medium": medium,
                    "language": "en" if domain == "language_expression" else "zxx",
                    "era": "procedural",
                    "channels": ["observation", "action_consequence", "interpretation"],
                    "channel_objects": {
                        "observation": [{"sha256": observation_sha, "media_type": "text/plain; charset=utf-8" if medium == "text" else "application/x-sidepus-observation-u8", "bytes": len(observation)}],
                        "action_consequence": [{"sha256": consequence_sha, "media_type": "application/x-sidepus-consequence-u8", "bytes": len(consequence)}],
                        "interpretation": [{"sha256": hidden_sha, "media_type": "application/json", "bytes": len(hidden_payload), "visibility": "hidden-generator-truth"}],
                    },
                    "rights": {"approved_by_operator": True, "allow_training": True, "basis": "deterministic-procedural-generation"},
                    "quality_score": 0.9,
                    "flags": flags,
                    "source_host": HOST,
                    "sequence_id": sequence_id,
                    "episode_id": sequence_id,
                    "sequence_index": index,
                    "sequence_length": steps,
                })
                counts[f"domain:{domain}"] += 1
    rows.sort(key=lambda row: (row["sequence_id"], row["sequence_index"]))
    payload = "".join(stable_json(row) + "\n" for row in rows).encode()
    atomic_bytes(output, payload)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "seed": seed,
        "episodes_per_domain": episodes_per_domain,
        "steps_per_episode": steps,
        "records": len(rows),
        "sequences": episodes_per_domain * len(DOMAINS),
        "counts": dict(sorted(counts.items())),
        "output": str(output),
        "output_sha256": hashlib.sha256(payload).hexdigest(),
        "claim_boundary": "Procedural episodes broaden training pressure but do not substitute for real perception, culture, language acquisition, or social interaction.",
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    atomic_bytes(output.with_suffix(output.suffix + ".receipt.json"), (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--episodes-per-domain", type=int, default=128)
    parser.add_argument("--steps", type=int, default=16)
    parser.add_argument("--seed", type=int, default=20260725)
    args = parser.parse_args()
    generate(pathlib.Path(args.state_dir), pathlib.Path(args.output), args.episodes_per_domain, args.steps, args.seed)


if __name__ == "__main__":
    main()
