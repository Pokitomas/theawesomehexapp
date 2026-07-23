#!/usr/bin/env python3
"""Generate nonlinguistic Sidepus microphysics episodes as raw sensory bytes.

The model-visible channels contain only raster bytes and compact action/consequence bytes.
Exact body state, generator parameters, and counterfactual truth remain hidden in
interpretation/evaluation objects. Episodes are split into ordered records so persistent
state is useful across windows.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import tempfile
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
GENERATOR_SCHEMA = "sidepus-microphysics-generator/v1"
RECEIPT_SCHEMA = "sidepus-microphysics-receipt/v1"
HOST = "microphysics.procedural.sidepus.invalid"


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def atomic_bytes(path: pathlib.Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != payload:
            raise RuntimeError(f"content-addressed object collision: {path}")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def atomic_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def put_object(state_dir: pathlib.Path, payload: bytes) -> tuple[str, pathlib.Path]:
    digest = hashlib.sha256(payload).hexdigest()
    path = state_dir / "objects" / "sha256" / digest[:2] / digest[2:]
    atomic_bytes(path, payload)
    return digest, path


@dataclass
class Body:
    identity: int
    x: float
    y: float
    vx: float
    vy: float
    mass: float
    intensity: int


def initial_bodies(rng: np.random.Generator, count: int, size: int) -> list[Body]:
    bodies: list[Body] = []
    for identity in range(count):
        for _ in range(100):
            x, y = rng.uniform(1.5, size - 2.5, size=2)
            if all((x - body.x) ** 2 + (y - body.y) ** 2 > 10.0 for body in bodies):
                break
        angle = rng.uniform(0, 2 * math.pi)
        speed = rng.uniform(0.35, 0.9)
        bodies.append(Body(
            identity=identity,
            x=float(x), y=float(y),
            vx=float(math.cos(angle) * speed),
            vy=float(math.sin(angle) * speed),
            mass=float(rng.uniform(0.7, 1.6)),
            intensity=int(70 + identity * (160 // max(count - 1, 1))),
        ))
    return bodies


def kinetic_energy(bodies: list[Body]) -> float:
    return sum(0.5 * body.mass * (body.vx * body.vx + body.vy * body.vy) for body in bodies)


def apply_impulse(body: Body, ix: float, iy: float) -> None:
    body.vx += ix / body.mass
    body.vy += iy / body.mass


def advance(bodies: list[Body], size: int) -> int:
    collisions = 0
    for body in bodies:
        body.x += body.vx
        body.y += body.vy
        if body.x < 1.0:
            body.x = 1.0 + (1.0 - body.x); body.vx = abs(body.vx); collisions += 1
        elif body.x > size - 2.0:
            body.x = size - 2.0 - (body.x - (size - 2.0)); body.vx = -abs(body.vx); collisions += 1
        if body.y < 1.0:
            body.y = 1.0 + (1.0 - body.y); body.vy = abs(body.vy); collisions += 1
        elif body.y > size - 2.0:
            body.y = size - 2.0 - (body.y - (size - 2.0)); body.vy = -abs(body.vy); collisions += 1
    for left in range(len(bodies)):
        for right in range(left + 1, len(bodies)):
            a, b = bodies[left], bodies[right]
            dx, dy = b.x - a.x, b.y - a.y
            distance2 = dx * dx + dy * dy
            if distance2 >= 4.0 or distance2 <= 1e-8:
                continue
            distance = math.sqrt(distance2)
            nx, ny = dx / distance, dy / distance
            relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
            if relative >= 0:
                continue
            impulse = (2 * relative) / (a.mass + b.mass)
            a.vx += impulse * b.mass * nx
            a.vy += impulse * b.mass * ny
            b.vx -= impulse * a.mass * nx
            b.vy -= impulse * a.mass * ny
            overlap = 2.0 - distance
            a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5
            b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5
            collisions += 1
    return collisions


def render(bodies: list[Body], size: int, occluder_x: int | None) -> bytes:
    frame = np.zeros((size, size), dtype=np.uint8)
    for body in bodies:
        x, y = int(round(body.x)), int(round(body.y))
        for dy in (0, 1):
            for dx in (0, 1):
                px, py = min(size - 1, x + dx), min(size - 1, y + dy)
                if occluder_x is not None and occluder_x <= px < occluder_x + 2:
                    continue
                frame[py, px] = np.uint8(body.intensity)
    if occluder_x is not None:
        frame[:, occluder_x:occluder_x + 2] = np.uint8(32)
    return frame.tobytes(order="C")


def encode_action(
    body_id: int | None, impulse_x: float, impulse_y: float,
    collisions: int, energy_delta: float,
) -> bytes:
    encode_signed = lambda value, scale: max(0, min(255, 128 + int(round(value * scale))))
    return bytes((
        255 if body_id is None else max(0, min(254, body_id)),
        encode_signed(impulse_x, 48),
        encode_signed(impulse_y, 48),
        max(0, min(255, collisions)),
        encode_signed(energy_delta, 16),
    ))


def body_state(bodies: list[Body]) -> list[dict[str, Any]]:
    return [
        {
            "identity": body.identity,
            "x": round(body.x, 6), "y": round(body.y, 6),
            "vx": round(body.vx, 6), "vy": round(body.vy, 6),
            "mass": round(body.mass, 6), "intensity": body.intensity,
        }
        for body in bodies
    ]


def generate_episode(
    *, episode_index: int, seed: int, size: int, body_count: int,
    frames: int, frames_per_record: int,
) -> tuple[list[bytes], list[bytes], list[dict[str, Any]]]:
    rng = np.random.default_rng(seed + episode_index * 104729)
    bodies = initial_bodies(rng, body_count, size)
    occluder_x = int(rng.integers(size // 3, 2 * size // 3)) if episode_index % 2 == 0 else None
    raster_frames: list[bytes] = []
    action_frames: list[bytes] = []
    truth: list[dict[str, Any]] = []
    for frame_index in range(frames):
        before_energy = kinetic_energy(bodies)
        acted: int | None = None
        ix = iy = 0.0
        if frame_index > 0 and rng.random() < 0.28:
            acted = int(rng.integers(0, len(bodies)))
            angle = rng.uniform(0, 2 * math.pi)
            magnitude = rng.uniform(0.15, 0.65)
            ix, iy = float(math.cos(angle) * magnitude), float(math.sin(angle) * magnitude)
            apply_impulse(bodies[acted], ix, iy)
        collisions = advance(bodies, size) if frame_index > 0 else 0
        after_energy = kinetic_energy(bodies)
        raster_frames.append(render(bodies, size, occluder_x))
        action_frames.append(encode_action(acted, ix, iy, collisions, after_energy - before_energy))
        truth.append({
            "frame": frame_index,
            "bodies": body_state(bodies),
            "action": {"body": acted, "impulse_x": ix, "impulse_y": iy},
            "collisions": collisions,
            "kinetic_energy": after_energy,
            "occluder_x": occluder_x,
        })
    chunks = math.ceil(frames / frames_per_record)
    observations, actions, truths = [], [], []
    for chunk in range(chunks):
        start, end = chunk * frames_per_record, min(frames, (chunk + 1) * frames_per_record)
        observations.append(b"".join(raster_frames[start:end]))
        actions.append(b"".join(action_frames[start:end]))
        truths.append({
            "schema": "sidepus-microphysics-hidden-truth/v1",
            "episode": episode_index,
            "chunk": chunk,
            "frame_range": [start, end],
            "states": truth[start:end],
        })
    return observations, actions, truths


def generate(
    *, state_dir: pathlib.Path, output: pathlib.Path, episodes: int, seed: int,
    size: int, body_count: int, frames: int, frames_per_record: int,
) -> dict[str, Any]:
    if episodes < 1 or size < 8 or body_count < 1 or frames < 2 or frames_per_record < 1:
        raise ValueError("invalid microphysics dimensions")
    state_dir = state_dir.expanduser().resolve()
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    object_digests: set[str] = set()
    for episode in range(episodes):
        observations, actions, truths = generate_episode(
            episode_index=episode, seed=seed, size=size, body_count=body_count,
            frames=frames, frames_per_record=frames_per_record,
        )
        sequence_id = f"microphysics:{seed}:{episode:08d}"
        for chunk, (observation, action, hidden) in enumerate(zip(observations, actions, truths)):
            observation_sha, _ = put_object(state_dir, observation)
            action_sha, _ = put_object(state_dir, action)
            hidden_payload = (stable_json(hidden) + "\n").encode()
            hidden_sha, _ = put_object(state_dir, hidden_payload)
            evaluation = {
                "schema": "sidepus-microphysics-evaluation/v1",
                "sequence_id": sequence_id,
                "sequence_index": chunk,
                "observation_sha256": observation_sha,
                "action_sha256": action_sha,
                "hidden_truth_sha256": hidden_sha,
            }
            evaluation_sha, _ = put_object(state_dir, (stable_json(evaluation) + "\n").encode())
            object_digests.update((observation_sha, action_sha, hidden_sha, evaluation_sha))
            record_id = f"micro_{hashlib.sha256(f'{sequence_id}:{chunk}'.encode()).hexdigest()[:32]}"
            rows.append({
                "schema": INVENTORY_SCHEMA,
                "record_id": record_id,
                "object_sha256": observation_sha,
                "bytes": len(observation) + len(action),
                "estimated_tokens": len(observation) + len(action),
                "domain": "multimodal_episode",
                "medium": "video",
                "language": "zxx",
                "era": "procedural",
                "channels": ["observation", "action_consequence", "interpretation", "evaluation_only"],
                "channel_objects": {
                    "observation": [{
                        "sha256": observation_sha,
                        "media_type": "application/x-sidepus-raster-u8",
                        "bytes": len(observation),
                        "representation": "raster-time-u8",
                        "shape": [len(observation) // (size * size), size, size],
                        "layout": "frame-major-row-major",
                    }],
                    "action_consequence": [{
                        "sha256": action_sha,
                        "media_type": "application/x-sidepus-action-u8",
                        "bytes": len(action),
                        "representation": "action-u8",
                        "bytes_per_transition": 5,
                    }],
                    "interpretation": [{
                        "sha256": hidden_sha,
                        "media_type": "application/json",
                        "bytes": len(hidden_payload),
                        "visibility": "hidden-generator-truth",
                    }],
                    "evaluation_only": [{
                        "sha256": evaluation_sha,
                        "media_type": "application/json",
                        "visibility": "evaluation-only",
                    }],
                },
                "rights": {
                    "allow_training": True,
                    "status": "operator-generated-procedural",
                    "label": "sidepus-microphysics",
                },
                "quality_score": 1.0,
                "flags": ["operator-generated", "procedural", "nonlinguistic", "ordered-episode"],
                "source_host": HOST,
                "episode_id": sequence_id,
                "sequence_id": sequence_id,
                "sequence_index": chunk,
                "sequence_length": len(observations),
                "generator": {
                    "schema": GENERATOR_SCHEMA,
                    "seed": seed,
                    "episode": episode,
                    "sensor_shape": [size, size],
                    "frames_per_record": frames_per_record,
                },
            })
    rows.sort(key=lambda row: (str(row["sequence_id"]), int(row["sequence_index"])))
    temporary = output.with_suffix(output.suffix + ".tmp")
    hasher = hashlib.sha256()
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            encoded = stable_json(row)
            handle.write(encoded + "\n")
            hasher.update((encoded + "\n").encode())
        handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, output)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "generator": GENERATOR_SCHEMA,
        "state_dir": str(state_dir),
        "inventory": str(output),
        "inventory_sha256": sha256_file(output),
        "inventory_digest": hasher.hexdigest(),
        "episodes": episodes,
        "records": len(rows),
        "objects": len(object_digests),
        "seed": seed,
        "configuration": {
            "size": size, "body_count": body_count, "frames": frames,
            "frames_per_record": frames_per_record,
        },
        "visible_boundary": (
            "Model-visible objects are raw raster and action/consequence bytes. Exact body identity, position, velocity, mass, "
            "collision truth, and generator state are separate hidden/evaluation objects."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    atomic_json(output.with_suffix(output.suffix + ".receipt.json"), receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--episodes", type=int, default=256)
    parser.add_argument("--seed", type=int, default=20260725)
    parser.add_argument("--size", type=int, default=16)
    parser.add_argument("--body-count", type=int, default=3)
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("--frames-per-record", type=int, default=2)
    args = parser.parse_args()
    generate(
        state_dir=pathlib.Path(args.state_dir), output=pathlib.Path(args.output),
        episodes=args.episodes, seed=args.seed, size=args.size,
        body_count=args.body_count, frames=args.frames,
        frames_per_record=args.frames_per_record,
    )


if __name__ == "__main__":
    main()
