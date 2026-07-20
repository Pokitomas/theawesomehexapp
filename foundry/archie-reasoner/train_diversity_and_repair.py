#!/usr/bin/env python3
"""Train product-diversity and abandoned-state repair artifacts.

Outputs remain promotion:not-admitted and bind exact source/audit identities.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from diversity_training_audit import read_audit_evidence
from diversity_training_io import stable_json, write_chunked_json, write_json
from diversity_training_linear import SEED, train_export_model
from diversity_training_repair import make_repair_dataset
from diversity_training_visual import make_visual_dataset
from diversity_training_visual_data import (
    DENSITIES, HELDOUT_TEMPLATES, MOTIONS, TRAIN_TEMPLATES,
    VISUAL_ARCHETYPES, VISUAL_LAYOUTS, VISUAL_STYLES,
)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-root", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path.cwd())
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--visual-train-rows", type=int, default=36000)
    parser.add_argument("--visual-heldout-rows", type=int, default=7200)
    parser.add_argument("--repair-train-rows", type=int, default=48000)
    parser.add_argument("--repair-heldout-rows", type=int, default=8000)
    args = parser.parse_args()

    visual_train = make_visual_dataset(args.visual_train_rows, TRAIN_TEMPLATES, SEED)
    visual_test = make_visual_dataset(args.visual_heldout_rows, HELDOUT_TEMPLATES, SEED + 1)
    visual_model, visual_receipt = train_export_model(visual_train, visual_test, schema="archie-product-blueprint-linear/v1", max_features=1400, alpha=1e-5, sparse_features=24)
    visual_model_directory = args.output_root / "archie/product-style-model"
    visual_manifest = write_chunked_json(visual_model_directory, visual_model)
    visual_receipt.update({
        "source_sha": args.source_sha,
        "artifact": {
            "path": "archie/product-style-model/manifest.json",
            "logical_sha256": visual_manifest["logical_sha256"],
            "logical_bytes": visual_manifest["logical_bytes"],
            "part_count": len(visual_manifest["parts"]),
            "parts": visual_manifest["parts"],
        },
        "diversity_axes": {"archetypes": len(VISUAL_ARCHETYPES), "layouts": len(VISUAL_LAYOUTS), "styles": len(VISUAL_STYLES), "densities": len(DENSITIES), "motions": len(MOTIONS)},
        "claim_boundary": "The compact model selects bounded product blueprints. It does not generate arbitrary production software or replace the Archie reasoning model.",
    })
    visual_receipt_sha = write_json(args.output_root / "archie/product-style-model-receipt.json", visual_receipt, compact=True)

    repair_train = make_repair_dataset(args.repair_train_rows, SEED + 2, heldout=False)
    repair_test = make_repair_dataset(args.repair_heldout_rows, SEED + 3, heldout=True)
    repair_model, repair_receipt = train_export_model(repair_train, repair_test, schema="archie-audit-repair-gate-linear/v1", max_features=1800, alpha=1e-5, sparse_features=96)
    repair_model_directory = args.output_root / "foundry/archie-reasoner/artifacts/audit-repair-gate"
    repair_manifest = write_chunked_json(repair_model_directory, repair_model)
    evidence = read_audit_evidence(args.audit_root)
    repair_receipt.update({
        "source_sha": args.source_sha,
        "artifact": {
            "path": "foundry/archie-reasoner/artifacts/audit-repair-gate/manifest.json",
            "logical_sha256": repair_manifest["logical_sha256"],
            "logical_bytes": repair_manifest["logical_bytes"],
            "part_count": len(repair_manifest["parts"]),
            "parts": repair_manifest["parts"],
        },
        "audit_evidence": evidence,
        "targeted_failure_clusters": ["auto_route_agreement", "tool_exact_match", "mutating_confirmation", "red_team_abstention"],
        "source_suite_status": "development-invalidated-for-adaptive-repair" if evidence.get("available") else "audit-unavailable",
        "claim_boundary": "This is an auxiliary repair gate trained after inspecting prior failures. It cannot admit or replace the frozen generative checkpoint and remains promotion:not-admitted.",
    })
    repair_receipt_sha = write_json(args.output_root / "foundry/archie-reasoner/artifacts/audit-repair-receipt.json", repair_receipt, compact=True)

    print(stable_json({
        "visual_model_sha256": visual_manifest["logical_sha256"],
        "visual_receipt_sha256": visual_receipt_sha,
        "visual_metrics": visual_receipt["metrics"],
        "repair_model_sha256": repair_manifest["logical_sha256"],
        "repair_receipt_sha256": repair_receipt_sha,
        "repair_metrics": repair_receipt["metrics"],
        "audit_evidence": evidence,
        "promotion": "not-admitted",
    }))


if __name__ == "__main__":
    main()
