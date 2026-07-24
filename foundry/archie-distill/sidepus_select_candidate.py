#!/usr/bin/env python3
"""Select a Sidepus checkpoint on development evidence before admission is opened."""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
from typing import Any

from archie_hybrid_corpus import sha256_file
from sidepus_pursuit_plan import digest_json

COURT_SCHEMA = "archie-sidepus-disjoint-causal-court/v1"
SELECTION_SCHEMA = "archie-sidepus-development-selection/v1"


def load_court(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != COURT_SCHEMA:
        raise ValueError(f"unsupported development court: {path}")
    body = dict(value)
    expected = body.pop("receipt_digest", None)
    if expected != digest_json(body):
        raise ValueError(f"development court digest mismatch: {path}")
    binding = value.get("split_binding")
    if not isinstance(binding, dict) or binding.get("name") != "development":
        raise ValueError(f"court is not bound to development evidence: {path}")
    return value


def parse_candidate(value: str) -> tuple[pathlib.Path, pathlib.Path]:
    model, separator, court = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("candidate must be MODEL=COURT")
    return pathlib.Path(model).expanduser().resolve(), pathlib.Path(court).expanduser().resolve()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", action="append", required=True, type=parse_candidate)
    parser.add_argument("--output-model", required=True)
    parser.add_argument("--output-receipt", required=True)
    args = parser.parse_args()

    candidates: list[dict[str, Any]] = []
    plan_sha: str | None = None
    split_binding: dict[str, Any] | None = None
    for model_path, court_path in args.candidate:
        if not model_path.is_file() or not court_path.is_file():
            raise SystemExit(f"missing development candidate: {model_path} or {court_path}")
        court = load_court(court_path)
        if plan_sha is None:
            plan_sha = str(court["plan_sha256"])
            split_binding = dict(court["split_binding"])
        elif court.get("plan_sha256") != plan_sha or court.get("split_binding") != split_binding:
            raise SystemExit("development candidates were not judged by the same evidence court")
        candidates.append({
            "model": str(model_path),
            "model_sha256": sha256_file(model_path),
            "court": str(court_path),
            "court_sha256": sha256_file(court_path),
            "development_score": float(court["development_score"]),
            "passed": bool(court["passed"]),
        })
    if not candidates:
        raise SystemExit("no development candidates supplied")

    # Development score fixes checkpoint identity. A falsified candidate set still selects
    # its least-bad member so the untouched admission split can expose the failure honestly.
    winner = max(candidates, key=lambda item: (item["development_score"], item["model_sha256"]))
    output_model = pathlib.Path(args.output_model).expanduser().resolve()
    output_model.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(winner["model"], output_model)
    receipt: dict[str, Any] = {
        "schema": SELECTION_SCHEMA,
        "development_plan_sha256": plan_sha,
        "split_binding": split_binding,
        "candidates": candidates,
        "selected_source_model": winner["model"],
        "selected_source_sha256": winner["model_sha256"],
        "selected_development_score": winner["development_score"],
        "selected_court_passed": winner["passed"],
        "output_model": str(output_model),
        "output_model_sha256": sha256_file(output_model),
        "selection_rule": "maximum development_score; SHA-256 lexical tie break",
        "claim_boundary": (
            "Checkpoint identity was fixed on development evidence before admission evaluation. "
            "Selection does not imply that any court passed."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    output_receipt = pathlib.Path(args.output_receipt).expanduser().resolve()
    output_receipt.parent.mkdir(parents=True, exist_ok=True)
    output_receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
