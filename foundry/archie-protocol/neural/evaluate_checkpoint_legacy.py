#!/usr/bin/env python3
"""Evaluate a NumPy Archie checkpoint on exact frozen legacy route suites."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

import np_transformer as nt


SUITES = {
    "router-v2-original-heldout": "188d67330955a67bdb24a1bb096f2910eaa13a268b48dde77216cdd4f8be40f5",
    "router-real-v2-heldout": "72c0d30af384c42c54e244c6466f1ed710a1f58b157ed26cceb65f9d91068f64",
    "router-real-v3-final": "cb9131eaa0888d14a8e68f83e0486221b9b3dc5bf5b31a0df1a1f016433594dd",
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest_json(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_model(receipt: dict, weights_path: Path) -> tuple[nt.Model, dict[str, int]]:
    config = receipt["config"]
    tokens = receipt["data"]["vocab_tokens"]
    vmap = {token: index for index, token in enumerate(tokens)}
    model = nt.Model(
        len(vmap),
        int(config["d"]),
        int(config["layers"]),
        int(config["heads"]),
        int(config["tmax"]),
        int(config["seed"]),
    )
    saved = np.load(weights_path)
    missing = sorted(set(model.P) - set(saved.files))
    extra = sorted(set(saved.files) - set(model.P))
    if missing or extra:
        raise SystemExit(f"checkpoint schema mismatch missing={missing} extra={extra}")
    for key in model.P:
        if saved[key].shape != model.P[key].shape:
            raise SystemExit(f"checkpoint shape mismatch for {key}")
        model.P[key][...] = saved[key]
    return model, vmap


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--weights", required=True)
    parser.add_argument("--legacy-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    receipt_path = Path(args.receipt)
    weights_path = Path(args.weights)
    legacy_dir = Path(args.legacy_dir)
    source = json.loads(receipt_path.read_text())
    expected_weights = source.get("model", {}).get("weights_sha256")
    actual_weights = sha256_file(weights_path)
    if expected_weights and actual_weights != expected_weights:
        raise SystemExit("checkpoint weight digest mismatch")

    model, vmap = load_model(source, weights_path)
    temperature = float(source["config"].get("route_temperature", 1.0))
    results = {}
    suite_evidence = {}
    for name, expected_digest in SUITES.items():
        path = legacy_dir / f"{name}.jsonl"
        actual_digest = sha256_file(path)
        if actual_digest != expected_digest:
            raise SystemExit(f"legacy suite digest mismatch: {name}")
        rows = nt.legacy_rows(path)
        results[name] = nt.eval_legacy(model, rows, vmap, int(source["config"]["tmax"]), temperature)
        suite_evidence[name] = {
            "sha256": actual_digest,
            "examples": len(rows),
        }

    all_exact = all(result["route_accuracy"] == 1.0 for result in results.values())
    evaluation = {
        "schema": "archie-exact-legacy-evaluation/v1",
        "checkpoint_tag": source["tag"],
        "checkpoint_weights_sha256": actual_weights,
        "source_receipt_digest": source.get("receipt_digest"),
        "route_temperature": temperature,
        "suites": suite_evidence,
        "results": results,
        "total_examples": sum(item["examples"] for item in suite_evidence.values()),
        "exact_legacy_retention": all_exact,
        "promotion": "not-admitted",
        "claim_boundary": "This receipt proves only exact legacy route retention or regression. Full promotion still requires all protected capability, authority, abstention, runtime-parity, and resource gates.",
    }
    evaluation["receipt_digest"] = digest_json(evaluation)
    Path(args.out).write_text(json.dumps(evaluation, indent=2) + "\n")
    print(json.dumps(evaluation, indent=2))


if __name__ == "__main__":
    main()
