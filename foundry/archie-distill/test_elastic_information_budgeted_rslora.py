#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("elastic_information_budgeted_rslora.py")
spec = importlib.util.spec_from_file_location("elastic_information_budgeted_rslora", MODULE_PATH)
assert spec and spec.loader
elastic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(elastic)


class ElasticRSLoRATest(unittest.TestCase):
    def test_rung_targets_partition_budget_strictly(self) -> None:
        self.assertEqual(elastic.rung_targets(100, 4), [25, 50, 75, 100])
        self.assertEqual(elastic.rung_targets(7, 3), [3, 5, 7])
        with self.assertRaises(SystemExit):
            elastic.rung_targets(2, 3)

    def test_optimizer_steps_matches_single_worker_accumulation(self) -> None:
        self.assertEqual(elastic.optimizer_steps(17, 1, 8, 2.0), 6)
        self.assertEqual(elastic.optimizer_steps(16, 2, 4, 1.0), 2)

    def test_latest_checkpoint_requires_optimizer_and_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            bad = root / "checkpoint-3"
            bad.mkdir()
            (bad / "trainer_state.json").write_text('{"global_step":3}\n')
            with self.assertRaises(SystemExit):
                elastic.latest_checkpoint(root)
            (bad / "optimizer.pt").write_bytes(b"optimizer")
            good = root / "checkpoint-8"
            good.mkdir()
            (good / "trainer_state.json").write_text('{"global_step":8}\n')
            (good / "optimizer.pt").write_bytes(b"optimizer-8")
            self.assertEqual(elastic.latest_checkpoint(root), good)

    def test_parent_checkpoint_is_exactly_bound(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            bundle = pathlib.Path(raw)
            checkpoint = bundle / "training" / "checkpoints" / "checkpoint-5"
            checkpoint.mkdir(parents=True)
            (checkpoint / "trainer_state.json").write_text('{"global_step":5}\n')
            (checkpoint / "optimizer.pt").write_bytes(b"optimizer")
            entries = elastic.file_manifest(checkpoint)
            body = {
                "schema": elastic.RUNG_SCHEMA,
                "request_id": "request-1",
                "code_revision": "abc",
                "shard_index": 0,
                "rung": 0,
                "rung_count": 2,
                "base_profile_sha256": "a" * 64,
                "effective_profile_sha256": "e" * 64,
                "preference_dataset_sha256": "b" * 64,
                "pair_receipt_digest": "c" * 64,
                "reference_cache_receipt_digest": "d" * 64,
                "student_checkpoint_directory_digest": "f" * 64,
                "total_optimizer_steps": 10,
                "previous_target_optimizer_step": 0,
                "target_optimizer_step": 5,
                "parent_rung_receipt_digest": None,
                "checkpoint": {
                    "relative_path": checkpoint.relative_to(bundle).as_posix(),
                    "global_step": 5,
                    "manifest": entries,
                    "manifest_digest": elastic.manifest_digest(entries),
                },
                "training_receipt": {"relative_path": "training/training-receipt.json", "sha256": "0" * 64, "receipt_digest": "1" * 64},
                "runner": {},
                "elapsed_seconds": 1.0,
                "promotion": "not-admitted",
                "claim_boundary": "test",
                "created_at": "2026-07-21T00:00:00Z",
            }
            receipt = {**body, "receipt_digest": elastic.digest(body)}
            (bundle / "elastic-rung-receipt.json").write_text(json.dumps(receipt))
            resolved, observed = elastic.parent_checkpoint(
                bundle,
                rung=1,
                request_id="request-1",
                shard_index=0,
                base_profile_sha256="a" * 64,
                dataset_sha256="b" * 64,
                pair_receipt_digest="c" * 64,
                student_directory_digest="f" * 64,
                total_steps=10,
                rung_count=2,
            )
            self.assertEqual(resolved, checkpoint)
            self.assertEqual(observed["receipt_digest"], receipt["receipt_digest"])
            (checkpoint / "optimizer.pt").write_bytes(b"tampered")
            with self.assertRaises(SystemExit):
                elastic.parent_checkpoint(
                    bundle,
                    rung=1,
                    request_id="request-1",
                    shard_index=0,
                    base_profile_sha256="a" * 64,
                    dataset_sha256="b" * 64,
                    pair_receipt_digest="c" * 64,
                    student_directory_digest="f" * 64,
                    total_steps=10,
                    rung_count=2,
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
