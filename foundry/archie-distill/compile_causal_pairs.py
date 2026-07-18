#!/usr/bin/env python3
"""Compile verifier-bound failed->repair trajectory pairs for neural preference training.

The compiler accepts one or more ``archie-trajectory-batch/v1`` files. A valid
pair is an admitted negative trajectory and an admitted positive trajectory
whose ``parent_trajectory_digest`` points to that negative trajectory. The two
trajectories must share the exact request bytes, so the resulting chosen and
rejected continuations are comparable under one policy state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
from typing import Any

PAIR_SCHEMA = "archie-causal-divergence-pair/v1"
RECEIPT_SCHEMA = "archie-causal-divergence-dataset-receipt/v1"


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def stable(value: Any) -> str:
    return json.dumps(canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    payload = value if isinstance(value, bytes) else (value.encode("utf-8") if isinstance(value, str) else stable(value).encode("utf-8"))
    return hashlib.sha256(payload).hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    return value


def verify_embedded(value: dict[str, Any], key: str, field: str) -> str:
    claimed = str(value.get(key) or "").lower()
    if len(claimed) != 64 or any(character not in "0123456789abcdef" for character in claimed):
        raise SystemExit(f"{field}.{key} must be a SHA-256 digest.")
    body = dict(value)
    body.pop(key, None)
    if digest(body) != claimed:
        raise SystemExit(f"{field}.{key} mismatch.")
    return claimed


def trajectory_target(trajectory: dict[str, Any]) -> str:
    events = [item for item in trajectory.get("events", []) if isinstance(item, dict) and item.get("type") != "request"]
    return stable({"events": events, "outcome": trajectory.get("outcome")})


def passed_independent_digests(trajectory: dict[str, Any]) -> list[str]:
    return sorted({
        str(item.get("evidence_digest"))
        for item in trajectory.get("verification", [])
        if isinstance(item, dict)
        and item.get("status") == "passed"
        and item.get("independent") is True
        and item.get("evidence_digest")
    })


def negative_evidence_digests(trajectory: dict[str, Any]) -> list[str]:
    return sorted({
        str(item.get("evidence_digest"))
        for item in trajectory.get("verification", [])
        if isinstance(item, dict)
        and item.get("status") in {"failed", "blocked"}
        and item.get("evidence_digest")
    })


def pair_from(parent: dict[str, Any], repair: dict[str, Any], parent_admission: dict[str, Any], repair_admission: dict[str, Any]) -> dict[str, Any]:
    if parent.get("request") != repair.get("request"):
        raise SystemExit(
            f"Repair trajectory {repair.get('trajectory_digest')} changes the request bytes of parent "
            f"{parent.get('trajectory_digest')}; refusing an invalid preference pair."
        )
    chosen_target = trajectory_target(repair)
    rejected_target = trajectory_target(parent)
    if chosen_target == rejected_target:
        raise SystemExit(f"Repair trajectory {repair.get('trajectory_digest')} is identical to its rejected parent.")
    positive_digests = passed_independent_digests(repair)
    negative_digests = negative_evidence_digests(parent)
    if not positive_digests:
        raise SystemExit(f"Repair trajectory {repair.get('trajectory_digest')} has no independent passed verification.")
    evidence_weight = min(4.0, 1.0 + 0.5 * len(positive_digests) + 0.25 * len(negative_digests))
    identity = {
        "parent_trajectory_digest": parent.get("trajectory_digest"),
        "repair_trajectory_digest": repair.get("trajectory_digest"),
        "parent_admission_digest": parent_admission.get("admission_digest"),
        "repair_admission_digest": repair_admission.get("admission_digest"),
    }
    body = {
        "schema": PAIR_SCHEMA,
        "pair_id": f"pair_{digest(identity)[:32]}",
        "group_id": f"repair-lineage:{parent.get('trajectory_digest')}",
        "instruction": str(parent.get("request") or ""),
        "compact_context": canonical({
            "subject": parent.get("subject"),
            "repository": parent.get("provenance", {}).get("repository"),
            "base_sha": parent.get("provenance", {}).get("base_sha"),
        }),
        "chosen_target": chosen_target,
        "rejected_target": rejected_target,
        "evidence_weight": evidence_weight,
        "verification_digests": positive_digests,
        "negative_evidence_digests": negative_digests,
        "provenance": identity,
    }
    return {**body, "pair_digest": digest(body)}


def compile_pairs(batch_paths: list[pathlib.Path], *, seed: int, holdout_rate: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    if not 0 <= holdout_rate < 1:
        raise SystemExit("holdout_rate must be in [0,1).")
    pairs: dict[str, dict[str, Any]] = {}
    batch_digests: list[str] = []
    for batch_index, path in enumerate(batch_paths):
        batch = read_json(path)
        if batch.get("schema") != "archie-trajectory-batch/v1":
            raise SystemExit(f"{path} is not an Archie trajectory batch v1.")
        batch_digests.append(verify_embedded(batch, "batch_digest", f"batch[{batch_index}]"))
        trajectories = {
            item.get("trajectory_digest"): item
            for item in batch.get("trajectories", [])
            if isinstance(item, dict) and item.get("trajectory_digest")
        }
        admissions = {
            item.get("trajectory_digest"): item
            for item in batch.get("admissions", [])
            if isinstance(item, dict) and item.get("trajectory_digest")
        }
        for repair in trajectories.values():
            parent_digest = repair.get("parent_trajectory_digest")
            if not parent_digest:
                continue
            parent = trajectories.get(parent_digest)
            parent_admission = admissions.get(parent_digest)
            repair_admission = admissions.get(repair.get("trajectory_digest"))
            if not parent or not parent_admission or not repair_admission:
                continue
            if parent_admission.get("admitted") is not True or parent_admission.get("negative") is not True:
                continue
            if repair_admission.get("admitted") is not True or repair_admission.get("positive") is not True:
                continue
            pair = pair_from(parent, repair, parent_admission, repair_admission)
            prior = pairs.get(pair["pair_id"])
            if prior and stable(prior) != stable(pair):
                raise SystemExit(f"Conflicting causal-divergence pair {pair['pair_id']}.")
            pairs[pair["pair_id"]] = pair
    ordered = [pairs[key] for key in sorted(pairs)]
    if not ordered:
        raise SystemExit("No admitted failed->verified-repair trajectory pairs were found.")
    train: list[dict[str, Any]] = []
    development: list[dict[str, Any]] = []
    for pair in ordered:
        unit = int(digest(f"{seed}:{pair['group_id']}")[:13], 16) / 0x1FFFFFFFFFFFFF
        (development if unit < holdout_rate else train).append(pair)
    if not train:
        train.append(development.pop(0))
    receipt_body = {
        "schema": RECEIPT_SCHEMA,
        "seed": seed,
        "holdout_rate": holdout_rate,
        "batch_digests": sorted(batch_digests),
        "pair_digests": [item["pair_digest"] for item in ordered],
        "counts": {"total": len(ordered), "train": len(train), "development": len(development)},
        "method": "verifier-anchored-parent-child-trajectory-pairing/v1",
        "claim_boundary": "This receipt proves deterministic preference-pair compilation. It does not prove that neural training ran or that a candidate improved.",
    }
    receipt = {**receipt_body, "receipt_digest": digest(receipt_body)}
    return train, development, receipt


def write_jsonl(path: pathlib.Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(f"{stable(row)}\n" for row in rows), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", action="append", required=True, help="Trajectory batch JSON; repeat for multiple batches")
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--holdout-rate", type=float, default=0.2)
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)
    train, development, receipt = compile_pairs(
        [pathlib.Path(item).resolve() for item in args.batch],
        seed=args.seed,
        holdout_rate=args.holdout_rate,
    )
    write_jsonl(output / "causal-preference.train.jsonl", train)
    write_jsonl(output / "causal-preference.development.jsonl", development)
    (output / "causal-preference-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
