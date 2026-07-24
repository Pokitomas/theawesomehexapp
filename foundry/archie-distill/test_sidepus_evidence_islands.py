#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import torch

from evaluate_archie_sidepus_pursuit import _deliberation_batch
from sidepus_evidence_split import split_inventory
from sidepus_pursuit_plan import digest_json


class SidepusEvidenceIslandTest(unittest.TestCase):
    def _inventory(self, root: pathlib.Path) -> pathlib.Path:
        rows = []
        common = "c" * 64
        for episode in range(30):
            for step in range(3):
                objects = [
                    {"sha256": f"{episode * 3 + step + 1:064x}", "media_type": "application/octet-stream"},
                    {"sha256": common, "media_type": "application/octet-stream"},
                ]
                if episode in {0, 1}:
                    objects.append({"sha256": "d" * 64, "media_type": "application/octet-stream"})
                rows.append({
                    "schema": "sidepus-developmental-inventory-record/v1",
                    "record_id": f"record-{episode}-{step}",
                    "sequence_id": f"episode-{episode}",
                    "sequence_index": step,
                    "domain": ("formal_executable", "empirical_world", "language_expression")[episode % 3],
                    "rights": {"allow_training": True},
                    "flags": [],
                    "channels": ["observation"],
                    "quality_score": 1.0,
                    "channel_objects": {"observation": objects},
                })
        path = root / "inventory.jsonl"
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
        return path

    def test_evidence_islands_are_deterministic_and_lineage_disjoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            inventory = self._inventory(root)
            first = split_inventory(
                inventory=inventory,
                output_dir=root / "first",
                seed=17,
                train_fraction=0.8,
                development_fraction=0.1,
                admission_fraction=0.1,
                maximum_link_frequency=8,
            )
            second = split_inventory(
                inventory=inventory,
                output_dir=root / "second",
                seed=17,
                train_fraction=0.8,
                development_fraction=0.1,
                admission_fraction=0.1,
                maximum_link_frequency=8,
            )
            self.assertTrue(first["hard_disjoint"])
            self.assertEqual(
                {name: value["record_id_digest"] for name, value in first["splits"].items()},
                {name: value["record_id_digest"] for name, value in second["splits"].items()},
            )
            self.assertTrue(all(value["records"] > 0 for value in first["splits"].values()))
            for overlap in first["pairwise_overlap"].values():
                self.assertEqual(overlap["record_id_overlap"], 0)
                self.assertEqual(overlap["lineage_overlap"], 0)
                self.assertEqual(overlap["linked_object_overlap"], 0)
                self.assertGreaterEqual(overlap["all_object_overlap"], 1)

            memberships: dict[str, str] = {}
            for split in ("train", "development", "admission"):
                path = root / "first" / f"{split}-inventory.jsonl"
                for line in path.read_text(encoding="utf-8").splitlines():
                    row = json.loads(line)
                    memberships[str(row["sequence_id"])] = split
            self.assertEqual(memberships["episode-0"], memberships["episode-1"])

    def test_deliberation_court_counts_token_oracle_and_halt_choice(self) -> None:
        inputs = torch.tensor([[0, 1, 2, 3]], dtype=torch.long)
        vocab = 5
        logits = torch.zeros(1, 4, vocab)
        logits[:, :-1].scatter_(2, inputs[:, 1:, None], 3.0)
        result = {
            "logits": logits,
            "deliberation_token_losses": torch.tensor([
                [[2.0, 1.0, 2.0]],
                [[1.0, 2.0, 1.0]],
            ]),
            "halt_weights": torch.tensor([[
                [0.0, 1.0],
                [1.0, 0.0],
                [0.0, 1.0],
                [1.0, 0.0],
            ]]),
        }
        values = _deliberation_batch(result, inputs, compute_cost=0.1)
        self.assertEqual(values["tokens"], 3.0)
        self.assertEqual(values["oracle_extra"], 2.0)
        self.assertEqual(values["halt_extra"], 2.0)
        self.assertEqual(values["halt_agreement"], 3.0)
        self.assertAlmostEqual(values["expected_steps"], 5.0)

    def test_development_selection_freezes_the_highest_scoring_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            model_a, model_b = root / "a.pt", root / "b.pt"
            model_a.write_bytes(b"candidate-a")
            model_b.write_bytes(b"candidate-b")
            binding = {"name": "development", "inventory_sha256": "1" * 64}

            def court(path: pathlib.Path, score: float, passed: bool) -> None:
                value = {
                    "schema": "archie-sidepus-disjoint-causal-court/v1",
                    "plan_sha256": "2" * 64,
                    "split_binding": binding,
                    "development_score": score,
                    "passed": passed,
                }
                value["receipt_digest"] = digest_json(value)
                path.write_text(json.dumps(value), encoding="utf-8")

            court_a, court_b = root / "a.json", root / "b.json"
            court(court_a, 0.25, False)
            court(court_b, 0.75, True)
            output_model, output_receipt = root / "selected.pt", root / "selection.json"
            subprocess.run([
                sys.executable,
                str(pathlib.Path(__file__).with_name("sidepus_select_candidate.py")),
                "--candidate", f"{model_a}={court_a}",
                "--candidate", f"{model_b}={court_b}",
                "--output-model", str(output_model),
                "--output-receipt", str(output_receipt),
            ], check=True, capture_output=True, text=True)
            self.assertEqual(output_model.read_bytes(), b"candidate-b")
            receipt = json.loads(output_receipt.read_text(encoding="utf-8"))
            self.assertEqual(receipt["selected_source_model"], str(model_b.resolve()))
            self.assertEqual(receipt["selected_development_score"], 0.75)
            self.assertTrue(receipt["selected_court_passed"])


if __name__ == "__main__":
    unittest.main()
