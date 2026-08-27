#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load("native", "nativize_alienware_rslora.py")
api = load("api", "alienware_rslora_ingest_api.py")


def build_bundle(root: pathlib.Path, request_id: str = "alienware-1") -> pathlib.Path:
    bundle = root / "bundle"
    checkpoint = bundle / "training" / "checkpoints" / "checkpoint-4"
    checkpoint.mkdir(parents=True)
    files = {
        "trainer_state.json": json.dumps({"global_step": 4, "epoch": 2.0}).encode(),
        "optimizer.pt": b"optimizer",
        "scheduler.pt": b"scheduler",
        "rng_state.pth": b"rng",
        "adapter_model.safetensors": b"adapter-bytes",
        "adapter_config.json": b'{"r":32}',
    }
    for name, body in files.items():
        (checkpoint / name).write_bytes(body)
    manifest = native.file_manifest(checkpoint) if hasattr(native, "file_manifest") else [
        {"path": path.relative_to(checkpoint).as_posix(), "bytes": path.stat().st_size, "sha256": native.sha256(path)}
        for path in sorted(checkpoint.rglob("*")) if path.is_file()
    ]
    training_receipt = {"schema": "test", "promotion": "not-admitted"}
    training_body = dict(training_receipt)
    training_receipt["receipt_digest"] = native.digest(training_body)
    training_path = bundle / "training" / "training-receipt.json"
    training_path.write_text(json.dumps(training_receipt))
    body = {
        "schema": native.REQUIRED_RECEIPT_SCHEMA,
        "request_id": request_id,
        "code_revision": "a" * 40,
        "shard_index": 0,
        "rung": 3,
        "rung_count": 4,
        "target_optimizer_step": 4,
        "base_profile_sha256": "b" * 64,
        "preference_dataset_sha256": "c" * 64,
        "student_checkpoint_directory_digest": "d" * 64,
        "tokenizer_identity_digest": "e" * 64,
        "checkpoint": {
            "relative_path": checkpoint.relative_to(bundle).as_posix(),
            "state_contract": {"files": {
                "trainer": "trainer_state.json", "optimizer": "optimizer.pt",
                "scheduler": "scheduler.pt", "rng": "rng_state.pth",
                "model": "adapter_model.safetensors",
            }},
            "manifest": manifest,
            "manifest_digest": native.digest(manifest),
        },
        "training_receipt": {
            "relative_path": training_path.relative_to(bundle).as_posix(),
            "sha256": native.sha256(training_path),
        },
        "runner": {"provider": "alienware", "runner_labels": ["cuda"]},
        "promotion": "not-admitted",
    }
    receipt = {**body, "receipt_digest": native.digest(body)}
    (bundle / "elastic-rung-receipt.json").write_text(json.dumps(receipt))
    return bundle


class AlienwareNativeTest(unittest.TestCase):
    def test_nativizes_without_runtime_connectors(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            result = native.nativize(build_bundle(root), root / "native", "alienware-1")
            self.assertEqual(result["promotion"], "not-admitted")
            self.assertFalse(result["connector_reduction"]["cuda_required"])
            self.assertEqual(result["connector_reduction"]["native_dependencies"], ["python-standard-library"])
            self.assertNotIn("runner", result["source"])
            self.assertTrue((root / "native" / "payload" / "adapter_model.safetensors").is_file())

    def test_tampered_checkpoint_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            bundle = build_bundle(root)
            (bundle / "training" / "checkpoints" / "checkpoint-4" / "optimizer.pt").write_bytes(b"tampered")
            with self.assertRaises(SystemExit):
                native.nativize(bundle, root / "native", "alienware-1")

    def test_request_identity_is_bound(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            with self.assertRaises(SystemExit):
                native.nativize(build_bundle(root), root / "native", "wrong")

    def test_tar_rejects_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            archive_path = root / "bad.tar"
            with tarfile.open(archive_path, "w") as archive:
                info = tarfile.TarInfo("../escape")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
            with tarfile.open(archive_path) as archive:
                with self.assertRaises(ValueError):
                    api.safe_extract(archive, root / "out")


if __name__ == "__main__":
    unittest.main(verbosity=2)
