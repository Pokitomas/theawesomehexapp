#!/usr/bin/env python3
"""ARCHIE action-first developmental court.

This intentionally does not teach shell syntax. It creates an isolated little
world, applies reversible state transformations, and records what changed.
The model-facing primitive is a transition/effect class; Bash/Python/UI can be
learned later as motor decoders for those transformations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA = "archie-action-latent/motor-babble-v1"
INFRA_DIRS = frozenset({"objects", "spaces", "moved"})


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot(root: Path) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_dir():
            result[rel] = {"kind": "dir"}
        elif path.is_file():
            result[rel] = {"kind": "file", "size": path.stat().st_size, "sha256": file_digest(path)}
    return result


def state_hash(state: dict[str, Any]) -> str:
    return digest(state)


def transition_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    b, a = set(before), set(after)
    created = sorted(a - b)
    deleted = sorted(b - a)
    changed = sorted(k for k in a & b if before[k] != after[k])

    def count(paths: list[str], state: dict[str, Any], kind: str) -> int:
        return sum(1 for p in paths if state.get(p, {}).get("kind") == kind)

    before_bytes = sum(v.get("size", 0) for v in before.values())
    after_bytes = sum(v.get("size", 0) for v in after.values())
    return {
        "created": created,
        "deleted": deleted,
        "changed": changed,
        "created_files": count(created, after, "file"),
        "created_dirs": count(created, after, "dir"),
        "deleted_files": count(deleted, before, "file"),
        "deleted_dirs": count(deleted, before, "dir"),
        "changed_files": count(changed, after, "file"),
        "byte_delta": after_bytes - before_bytes,
    }


def effect_signature(delta: dict[str, Any]) -> dict[str, Any]:
    byte_delta = int(delta["byte_delta"])
    return {
        "created_files": delta["created_files"],
        "created_dirs": delta["created_dirs"],
        "deleted_files": delta["deleted_files"],
        "deleted_dirs": delta["deleted_dirs"],
        "changed_files": delta["changed_files"],
        "byte_delta_sign": 0 if byte_delta == 0 else (1 if byte_delta > 0 else -1),
        "byte_delta_bucket": min(8, abs(byte_delta).bit_length()),
    }


@dataclass(frozen=True)
class Action:
    kind: str
    args: dict[str, Any]

    def public(self) -> dict[str, Any]:
        return {"kind": self.kind, "args": {k: v for k, v in self.args.items() if not k.startswith("_")}}


def resolve(root: Path, rel: str) -> Path:
    target = (root / rel).resolve()
    rr = root.resolve()
    if target != rr and rr not in target.parents:
        raise RuntimeError(f"action escaped sandbox: {rel}")
    return target


def apply_action(root: Path, action: Action) -> Action:
    kind, args = action.kind, action.args
    if kind == "mkdir":
        p = resolve(root, args["path"])
        if not p.parent.exists():
            raise RuntimeError(f"mkdir parent missing: {args['path']}")
        p.mkdir(exist_ok=False)
        return Action("rmdir", {"path": args["path"]})
    if kind == "rmdir":
        p = resolve(root, args["path"])
        p.rmdir()
        return Action("mkdir", {"path": args["path"]})
    if kind == "write":
        p = resolve(root, args["path"])
        existed = p.exists()
        old = p.read_text("utf-8") if existed else None
        if not p.parent.exists():
            raise RuntimeError(f"write parent missing: {args['path']}")
        p.write_text(args["text"], "utf-8")
        return Action("write", {"path": args["path"], "text": old}) if existed else Action("unlink", {"path": args["path"]})
    if kind == "append":
        p = resolve(root, args["path"])
        old = p.read_text("utf-8")
        p.write_text(old + args["text"], "utf-8")
        return Action("write", {"path": args["path"], "text": old})
    if kind == "unlink":
        p = resolve(root, args["path"])
        old = p.read_text("utf-8")
        p.unlink()
        return Action("write", {"path": args["path"], "text": old})
    if kind == "rename":
        src = resolve(root, args["src"])
        dst = resolve(root, args["dst"])
        if not dst.parent.exists():
            raise RuntimeError(f"rename parent missing: {args['dst']}")
        src.rename(dst)
        return Action("rename", {"src": args["dst"], "dst": args["src"]})
    raise ValueError(f"unknown action kind: {kind}")


def random_text(rng: random.Random) -> str:
    alphabet = "abcdef0123456789"
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 64)))


def choose_action(root: Path, rng: random.Random, nonce: int) -> Action:
    state = snapshot(root)
    files = [p for p, meta in state.items() if meta["kind"] == "file"]
    dirs = [p for p, meta in state.items() if meta["kind"] == "dir"]
    empty_dirs = [p for p in dirs if p not in INFRA_DIRS and not any(q != p and q.startswith(p + "/") for q in state)]
    choices = ["write-new", "mkdir"]
    if files:
        choices += ["write", "append", "unlink", "rename"]
    if empty_dirs:
        choices += ["rmdir"]
    kind = rng.choice(choices)
    if kind == "write-new":
        return Action("write", {"path": f"objects/f{nonce:06d}.dat", "text": random_text(rng)})
    if kind == "mkdir":
        return Action("mkdir", {"path": f"spaces/d{nonce:06d}"})
    if kind == "write":
        return Action("write", {"path": rng.choice(files), "text": random_text(rng)})
    if kind == "append":
        return Action("append", {"path": rng.choice(files), "text": random_text(rng)})
    if kind == "unlink":
        return Action("unlink", {"path": rng.choice(files)})
    if kind == "rename":
        return Action("rename", {"src": rng.choice(files), "dst": f"moved/m{nonce:06d}.dat"})
    if kind == "rmdir":
        return Action("rmdir", {"path": rng.choice(empty_dirs)})
    raise AssertionError(kind)


def initialize_world(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for rel in sorted(INFRA_DIRS):
        (root / rel).mkdir(exist_ok=True)


def run_court(root: Path, ledger: Path, steps: int, seed: int) -> dict[str, Any]:
    rng = random.Random(seed)
    initialize_world(root)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    inverse_failures: list[int] = []
    continuity_failures: list[int] = []
    code_counts: dict[str, int] = {}
    previous_after: str | None = state_hash(snapshot(root))
    with ledger.open("w", encoding="utf-8") as out:
        for i in range(steps):
            action = choose_action(root, rng, i)
            before = snapshot(root)
            before_hash = state_hash(before)
            if previous_after is not None and before_hash != previous_after:
                continuity_failures.append(i)
            t0 = time.perf_counter_ns()
            inverse = apply_action(root, action)
            after = snapshot(root)
            elapsed_us = (time.perf_counter_ns() - t0) / 1000.0
            after_hash = state_hash(after)
            delta = transition_delta(before, after)
            signature = effect_signature(delta)
            latent_code = digest(signature)[:16]
            code_counts[latent_code] = code_counts.get(latent_code, 0) + 1
            apply_action(root, inverse)
            inverse_ok = snapshot(root) == before
            if not inverse_ok:
                inverse_failures.append(i)
                raise RuntimeError(f"inverse court failed at step {i}: {action}")
            re_inverse = apply_action(root, action)
            replay_ok = snapshot(root) == after
            if not replay_ok:
                raise RuntimeError(f"deterministic replay failed at step {i}: {action}")
            record = {
                "schema": SCHEMA,
                "step": i,
                "seed": seed,
                "state_before_sha256": before_hash,
                "motor_action": action.public(),
                "state_after_sha256": after_hash,
                "outcome": {"ok": True, "elapsed_us": round(elapsed_us, 3)},
                "observed_delta": delta,
                "effect_signature": signature,
                "latent_action_code": latent_code,
                "courts": {"inverse_exact": inverse_ok, "replay_exact": replay_ok, "inverse_motor": re_inverse.public()},
            }
            out.write(canonical(record) + "\n")
            previous_after = after_hash
    return {
        "schema": SCHEMA,
        "root": str(root),
        "ledger": str(ledger),
        "steps": steps,
        "seed": seed,
        "inverse_failures": inverse_failures,
        "continuity_failures": continuity_failures,
        "inverse_pass_rate": 1.0 - len(inverse_failures) / max(1, steps),
        "continuity_pass_rate": 1.0 - len(continuity_failures) / max(1, steps),
        "latent_code_count": len(code_counts),
        "latent_code_histogram": dict(sorted(code_counts.items())),
        "ledger_sha256": file_digest(ledger),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=56)
    parser.add_argument("--root")
    parser.add_argument("--ledger")
    args = parser.parse_args()
    if args.steps < 1:
        raise SystemExit("--steps must be positive")
    temporary = None
    if args.root:
        root = Path(args.root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="archie-motor-babble-")
        root = Path(temporary.name)
    ledger = Path(args.ledger).expanduser().resolve() if args.ledger else root.parent / f"motor-babble-s{args.seed}.jsonl"
    try:
        print(json.dumps(run_court(root, ledger, args.steps, args.seed), indent=2, sort_keys=True))
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    main()
