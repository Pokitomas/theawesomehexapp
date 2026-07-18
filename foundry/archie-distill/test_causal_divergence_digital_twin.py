#!/usr/bin/env python3
"""Dependency-light tests for the causal-divergence Linux digital twin."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import run_causal_divergence_digital_twin as twin  # type: ignore


def digest(value):
    return hashlib.sha256(twin.stable(value).encode("utf-8")).hexdigest()


class CausalDigitalTwinTest(unittest.TestCase):
    def fixture(self, root: pathlib.Path):
        profile = {
            "schema": "archie-distill-profile/v1",
            "id": "digital-twin-fixture",
            "student": {"revision": "8d4744f9e13072f4920c326350fa81eedb74eae9"},
            "training": {
                "seed": 3407,
                "method": twin.METHOD,
                "epochs": 1,
                "learning_rate": 0.0001,
                "lora_rank": 16,
                "lora_alpha": 32,
            },
        }
        profile_path = root / "profile.json"
        profile_path.write_text(json.dumps(profile), encoding="utf-8")

        workspace = root / "workspace"
        workspace.mkdir()
        plan = {"schema": "archie-training-plan/v1", "plan_digest": "a" * 64}
        (workspace / "training-plan.json").write_text(json.dumps(plan), encoding="utf-8")

        pair_body = {
            "schema": twin.PAIR_SCHEMA,
            "pair_id": "pair_fixture",
            "instruction": "repair repository",
            "compact_context": None,
            "chosen_target": "abcXsafe",
            "rejected_target": "abcYunsafe",
            "evidence_weight": 2,
        }
        pair = {**pair_body, "pair_digest": digest(pair_body)}
        preference_path = root / "causal-preference.train.jsonl"
        preference_path.write_text(f"{json.dumps(pair)}\n", encoding="utf-8")

        receipt_body = {
            "schema": twin.PAIR_RECEIPT_SCHEMA,
            "seed": 3407,
            "holdout_rate": 0.2,
            "batch_digests": ["b" * 64],
            "pair_digests": [pair["pair_digest"]],
            "counts": {"total": 1, "train": 1, "development": 0},
            "method": "verifier-anchored-parent-child-trajectory-pairing/v1",
            "claim_boundary": "fixture",
        }
        preference_receipt_path = root / "causal-preference-receipt.json"
        preference_receipt_path.write_text(
            json.dumps({**receipt_body, "receipt_digest": digest(receipt_body)}),
            encoding="utf-8",
        )

        model_dir = root / "model"
        model_dir.mkdir()
        (model_dir / "config.json").write_text('{"model_type":"qwen3"}', encoding="utf-8")
        (model_dir / "tokenizer.json").write_text('{"version":"1.0"}', encoding="utf-8")
        (model_dir / "model.safetensors").write_bytes(b"fixture-model-bytes")
        return profile_path, workspace, preference_path, preference_receipt_path, model_dir

    def test_emits_non_neural_digest_bound_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            profile, workspace, preference, preference_receipt, model_dir = self.fixture(root)
            output = root / "digital-twin-output"

            def runtime_probe(_model_dir, rows, max_seq_length):
                self.assertEqual(len(rows), 1)
                self.assertEqual(max_seq_length, 256)
                return {
                    "python": "3.12-test",
                    "platform": "linux-test",
                    "packages": {name: "test" for name in twin.REQUIRED_PACKAGES},
                    "cuda_available": False,
                    "tokenization": {"rows": 1, "order_digest": "c" * 64},
                    "lora_construction": {"target_modules": "all-linear"},
                    "trainer_construction": {"epochs": 1},
                }

            def trainer_probe(command, *, environment):
                self.assertIn("train_causal_divergence.py", command[1])
                self.assertEqual(environment["CUDA_VISIBLE_DEVICES"], "")
                return {
                    "exit_code": 1,
                    "canonical_refusal_observed": True,
                    "output_sha256": "d" * 64,
                }

            receipt = twin.execute_digital_twin(
                profile_path=profile,
                workspace=workspace,
                preference_path=preference,
                preference_eval_path=None,
                preference_receipt_path=preference_receipt,
                model_dir=model_dir,
                output=output,
                max_seq_length=256,
                runtime_probe=runtime_probe,
                trainer_probe=trainer_probe,
            )
            self.assertEqual(receipt["schema"], twin.SCHEMA)
            self.assertEqual(receipt["executionMode"], "linux-digital-twin")
            self.assertIs(receipt["neuralEvidence"], False)
            self.assertEqual(receipt["gradient_steps"], 0)
            self.assertEqual(receipt["optimizer_steps"], 0)
            self.assertEqual(receipt["adapter_artifacts"], [])
            self.assertIs(receipt["neural_training_receipt_emitted"], False)
            self.assertEqual(receipt["promotion"], "not-admitted")
            body = dict(receipt)
            claimed = body.pop("receipt_digest")
            self.assertEqual(claimed, digest(body))
            stored = json.loads((output / "digital-twin-receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(stored["receipt_digest"], claimed)
            self.assertFalse(output.with_name(f"{output.name}-forbidden-neural-output").exists())

    def test_rejects_tampered_preference_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            profile, workspace, preference, preference_receipt, model_dir = self.fixture(root)
            value = json.loads(preference_receipt.read_text(encoding="utf-8"))
            value["counts"]["total"] = 2
            preference_receipt.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "integrity verification"):
                twin.verify_bundle(
                    profile_path=profile,
                    workspace=workspace,
                    preference_path=preference,
                    preference_eval_path=None,
                    preference_receipt_path=preference_receipt,
                    model_dir=model_dir,
                )

    def test_rejects_checkpoint_without_tokenizer_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            profile, workspace, preference, preference_receipt, model_dir = self.fixture(root)
            (model_dir / "tokenizer.json").unlink()
            with self.assertRaisesRegex(SystemExit, "no local tokenizer"):
                twin.verify_bundle(
                    profile_path=profile,
                    workspace=workspace,
                    preference_path=preference,
                    preference_eval_path=None,
                    preference_receipt_path=preference_receipt,
                    model_dir=model_dir,
                )

    def test_default_trainer_probe_requires_canonical_refusal(self):
        command = [
            sys.executable,
            "-c",
            f"import sys; print({twin.EXPECTED_REFUSAL!r}, file=sys.stderr); raise SystemExit(1)",
        ]
        result = twin.default_trainer_probe(command, environment=dict())
        self.assertEqual(result["exit_code"], 1)
        self.assertIs(result["canonical_refusal_observed"], True)

    def test_source_cannot_emit_cuda_training_receipt(self):
        source = (ROOT / "run_causal_divergence_digital_twin.py").read_text(encoding="utf-8")
        self.assertIn('"executionMode": "linux-digital-twin"', source)
        self.assertIn('"neuralEvidence": False', source)
        self.assertIn('"gradient_steps": 0', source)
        self.assertIn('"neural_training_receipt_emitted": False', source)
        self.assertNotIn('archie-neural-causal-divergence-training-receipt/v1', source)


if __name__ == "__main__":
    unittest.main()
