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


def write_checkpoint(root: pathlib.Path, step: int) -> pathlib.Path:
    checkpoint = root / "training" / "checkpoints" / f"checkpoint-{step}"
    checkpoint.mkdir(parents=True)
    (checkpoint / "trainer_state.json").write_text(json.dumps({"global_step": step}) + "\n")
    (checkpoint / "optimizer.pt").write_bytes(b"optimizer")
    (checkpoint / "scheduler.pt").write_bytes(b"scheduler")
    (checkpoint / "rng_state.pth").write_bytes(b"rng")
    (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter")
    return checkpoint


def write_parent_bundle(bundle: pathlib.Path, *, code_revision: str = "abc", cache_digest: str = "d" * 64, versions: dict[str, str] | None = None, step: int = 5) -> dict[str, object]:
    checkpoint = write_checkpoint(bundle, step)
    entries = elastic.file_manifest(checkpoint)
    body = {
        "schema": elastic.RUNG_SCHEMA,
        "request_id": "request-1",
        "code_revision": code_revision,
        "shard_index": 0,
        "rung": 0,
        "rung_count": 2,
        "base_profile_sha256": "a" * 64,
        "effective_profile_sha256": "e" * 64,
        "preference_dataset_sha256": "b" * 64,
        "pair_receipt_digest": "c" * 64,
        "reference_cache_receipt_digest": cache_digest,
        "student_checkpoint_directory_digest": "f" * 64,
        "training_package_versions": versions or {"torch": "2.test", "transformers": "4.test"},
        "total_optimizer_steps": 10,
        "previous_target_optimizer_step": 0,
        "target_optimizer_step": step,
        "parent_rung_receipt_digest": None,
        "checkpoint": {
            "relative_path": checkpoint.relative_to(bundle).as_posix(),
            "global_step": step,
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
    (bundle / "elastic-rung-receipt.json").write_text(json.dumps(receipt) + "\n")
    return receipt


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
            checkpoint = root / "checkpoint-3"
            checkpoint.mkdir()
            (checkpoint / "trainer_state.json").write_text('{"global_step":3}\n')
            (checkpoint / "optimizer.pt").write_bytes(b"optimizer")
            with self.assertRaises(SystemExit):
                elastic.latest_checkpoint(root)
            (checkpoint / "scheduler.pt").write_bytes(b"scheduler")
            (checkpoint / "rng_state.pth").write_bytes(b"rng")
            with self.assertRaises(SystemExit):
                elastic.latest_checkpoint(root)
            (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter")
            self.assertEqual(elastic.latest_checkpoint(root), checkpoint)

    def test_parent_checkpoint_is_exactly_bound(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            bundle = pathlib.Path(raw)
            versions = {"torch": "2.test", "transformers": "4.test"}
            receipt = write_parent_bundle(bundle, versions=versions)
            resolved, observed = elastic.parent_checkpoint(
                bundle,
                rung=1,
                request_id="request-1",
                code_revision="abc",
                shard_index=0,
                base_profile_sha256="a" * 64,
                dataset_sha256="b" * 64,
                pair_receipt_digest="c" * 64,
                reference_cache_receipt_digest="d" * 64,
                student_directory_digest="f" * 64,
                training_package_versions=versions,
                total_steps=10,
                previous_target_optimizer_step=5,
                rung_count=2,
            )
            self.assertEqual(resolved.name, "checkpoint-5")
            self.assertEqual(observed["receipt_digest"], receipt["receipt_digest"])

    def test_parent_checkpoint_refuses_drift_and_tamper(self) -> None:
        def expect_refusal(**overrides: object) -> None:
            with tempfile.TemporaryDirectory() as raw:
                bundle = pathlib.Path(raw)
                versions = {"torch": "2.test", "transformers": "4.test"}
                write_parent_bundle(bundle, versions=versions)
                kwargs = {
                    "rung": 1,
                    "request_id": "request-1",
                    "code_revision": "abc",
                    "shard_index": 0,
                    "base_profile_sha256": "a" * 64,
                    "dataset_sha256": "b" * 64,
                    "pair_receipt_digest": "c" * 64,
                    "reference_cache_receipt_digest": "d" * 64,
                    "student_directory_digest": "f" * 64,
                    "training_package_versions": versions,
                    "total_steps": 10,
                    "previous_target_optimizer_step": 5,
                    "rung_count": 2,
                }
                kwargs.update(overrides)
                with self.assertRaises(SystemExit):
                    elastic.parent_checkpoint(bundle, **kwargs)

        expect_refusal(code_revision="def")
        expect_refusal(reference_cache_receipt_digest="9" * 64)
        expect_refusal(training_package_versions={"torch": "other"})
        expect_refusal(previous_target_optimizer_step=6)

        with tempfile.TemporaryDirectory() as raw:
            bundle = pathlib.Path(raw)
            versions = {"torch": "2.test", "transformers": "4.test"}
            write_parent_bundle(bundle, versions=versions)
            (bundle / "training" / "checkpoints" / "checkpoint-5" / "optimizer.pt").write_bytes(b"tampered")
            with self.assertRaises(SystemExit):
                elastic.parent_checkpoint(
                    bundle,
                    rung=1,
                    request_id="request-1",
                    code_revision="abc",
                    shard_index=0,
                    base_profile_sha256="a" * 64,
                    dataset_sha256="b" * 64,
                    pair_receipt_digest="c" * 64,
                    reference_cache_receipt_digest="d" * 64,
                    student_directory_digest="f" * 64,
                    training_package_versions=versions,
                    total_steps=10,
                    previous_target_optimizer_step=5,
                    rung_count=2,
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
