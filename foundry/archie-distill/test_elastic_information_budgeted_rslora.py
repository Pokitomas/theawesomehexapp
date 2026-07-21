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


def write_checkpoint(root: pathlib.Path, step: int, *, scaler: bool = True) -> pathlib.Path:
    checkpoint = root / f"checkpoint-{step}"
    checkpoint.mkdir(parents=True)
    (checkpoint / "trainer_state.json").write_text(json.dumps({"global_step": step, "epoch": 0.5}) + "\n")
    (checkpoint / "optimizer.pt").write_bytes(b"optimizer")
    (checkpoint / "scheduler.pt").write_bytes(b"scheduler")
    (checkpoint / "rng_state.pth").write_bytes(b"rng")
    (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter")
    if scaler:
        (checkpoint / "scaler.pt").write_bytes(b"scaler")
    return checkpoint


class ElasticRSLoRATest(unittest.TestCase):
    def test_rung_targets_partition_budget_strictly(self) -> None:
        self.assertEqual(elastic.rung_targets(100, 4), [25, 50, 75, 100])
        self.assertEqual(elastic.rung_targets(7, 3), [3, 5, 7])
        with self.assertRaises(SystemExit):
            elastic.rung_targets(2, 3)

    def test_optimizer_steps_matches_single_worker_accumulation(self) -> None:
        self.assertEqual(elastic.optimizer_steps(17, 1, 8, 2.0), 6)
        self.assertEqual(elastic.optimizer_steps(16, 2, 4, 1.0), 2)

    def test_latest_checkpoint_requires_complete_resume_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            bad = write_checkpoint(root, 3)
            (bad / "scheduler.pt").unlink()
            with self.assertRaises(SystemExit):
                elastic.latest_checkpoint(root)
            bad.rename(root / "broken-checkpoint-3")
            good = write_checkpoint(root, 8)
            self.assertEqual(elastic.latest_checkpoint(root), good)
            (good / "scaler.pt").unlink()
            with self.assertRaises(SystemExit):
                elastic.latest_checkpoint(root)

    def test_parent_checkpoint_binds_revision_cache_software_and_cursor(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            bundle = pathlib.Path(raw)
            checkpoint = write_checkpoint(bundle / "training" / "checkpoints", 5)
            entries = elastic.file_manifest(checkpoint)
            contract = elastic.checkpoint_contract(checkpoint, require_scaler=True)
            body = {
                "schema": elastic.RUNG_SCHEMA,
                "request_id": "request-1",
                "code_revision": "abc",
                "shard_index": 0,
                "rung": 0,
                "rung_count": 2,
                "base_profile_sha256": "a" * 64,
                "effective_profile_sha256": "e" * 64,
                "training_config_sha256": "2" * 64,
                "training_plan_sha256": "3" * 64,
                "preference_dataset_sha256": "b" * 64,
                "pair_receipt_digest": "c" * 64,
                "reference_cache_receipt_digest": "d" * 64,
                "reference_cache_manifest_digest": "4" * 64,
                "student_checkpoint_directory_digest": "f" * 64,
                "tokenizer_identity_digest": "5" * 64,
                "software_identity": {},
                "software_identity_digest": "6" * 64,
                "total_optimizer_steps": 10,
                "previous_target_optimizer_step": 0,
                "target_optimizer_step": 5,
                "next_optimizer_step": 6,
                "parent_rung_receipt_digest": None,
                "sampler_cursor": {"cumulative_microbatches": 5, "cumulative_chain_digest": "7" * 64},
                "checkpoint": {
                    "relative_path": checkpoint.relative_to(bundle).as_posix(),
                    "global_step": 5,
                    "state_contract": contract,
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
            kwargs = dict(
                bundle=bundle,
                rung=1,
                request_id="request-1",
                code_revision="abc",
                shard_index=0,
                base_profile_sha256="a" * 64,
                training_config_sha256="2" * 64,
                training_plan_sha256_value="3" * 64,
                dataset_sha256="b" * 64,
                pair_receipt_digest="c" * 64,
                reference_cache_manifest_digest="4" * 64,
                student_directory_digest="f" * 64,
                tokenizer_identity_digest="5" * 64,
                software_identity_digest="6" * 64,
                total_steps=10,
                rung_count=2,
                require_scaler=True,
            )
            resolved, observed = elastic.parent_checkpoint(**kwargs)
            self.assertEqual(resolved, checkpoint)
            self.assertEqual(observed["receipt_digest"], receipt["receipt_digest"])
            for key, value in (
                ("code_revision", "changed"),
                ("reference_cache_manifest_digest", "8" * 64),
                ("software_identity_digest", "9" * 64),
            ):
                changed = dict(kwargs)
                changed[key] = value
                with self.assertRaises(SystemExit):
                    elastic.parent_checkpoint(**changed)
            (checkpoint / "optimizer.pt").write_bytes(b"tampered")
            with self.assertRaises(SystemExit):
                elastic.parent_checkpoint(**kwargs)

    def test_sampler_receipt_chains_pair_trace(self) -> None:
        first = elastic.sampler_receipt(
            pair_ids=["a", "b"], parent_receipt=None, state={"global_step": 1, "epoch": 0.25},
            row_count=4, batch_size=1, gradient_accumulation_steps=2, seed=17,
        )
        parent = {"sampler_cursor": first}
        second = elastic.sampler_receipt(
            pair_ids=["c"], parent_receipt=parent, state={"global_step": 2, "epoch": 0.5},
            row_count=4, batch_size=1, gradient_accumulation_steps=2, seed=17,
        )
        self.assertEqual(second["cumulative_microbatches"], 3)
        self.assertNotEqual(first["cumulative_chain_digest"], second["cumulative_chain_digest"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
