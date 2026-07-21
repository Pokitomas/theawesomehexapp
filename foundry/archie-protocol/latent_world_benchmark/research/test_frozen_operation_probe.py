from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import torch

MODULE_PATH = Path(__file__).resolve().with_name("frozen_operation_probe.py")
SPEC = importlib.util.spec_from_file_location("frozen_operation_probe", MODULE_PATH)
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class FrozenOperationProbeTests(unittest.TestCase):
    def test_ridge_probe_recovers_linearly_separable_labels(self) -> None:
        generator = torch.Generator().manual_seed(7)
        labels = torch.arange(3).repeat_interleave(80)
        centers = torch.eye(3, dtype=torch.float64)[labels]
        noise = 0.01 * torch.randn(240, 3, dtype=torch.float64, generator=generator)
        features = centers + noise
        fitted = probe.fit_ridge_probe(features, labels, 3, 185001)
        prediction = probe.predict_probe(fitted, features)
        self.assertGreater(float(prediction.eq(labels).double().mean()), 0.99)
        self.assertEqual(fitted["parameter_count"], 12)

    def test_confusion_and_per_operation_metrics(self) -> None:
        target = torch.tensor([0, 0, 1, 1, 2, 2])
        prediction = torch.tensor([0, 1, 1, 1, 2, 0])
        matrix = probe.confusion_matrix(prediction, target, 3)
        self.assertEqual(matrix, [[1, 1, 0], [0, 2, 0], [1, 0, 1]])
        metrics = probe.per_operation_metrics(matrix, ["a", "b", "c"])
        self.assertEqual(metrics[1]["support"], 2)
        self.assertEqual(metrics[1]["recall"], 1.0)
        self.assertAlmostEqual(metrics[0]["precision"], 0.5)

    def test_artifact_receipt_is_fail_closed(self) -> None:
        receipt = {
            "terminal": {**probe.EXPECTED_TERMINAL_ARTIFACT, "verified": True},
            "campaign": {**probe.EXPECTED_CAMPAIGN_ARTIFACT, "verified": True},
        }
        probe.verify_artifact_receipt(receipt)
        receipt["terminal"]["id"] += 1
        with self.assertRaises(RuntimeError):
            probe.verify_artifact_receipt(receipt)

    def test_state_dict_digest_changes_with_parameter(self) -> None:
        model = torch.nn.Linear(2, 2)
        before = probe.state_dict_digest(model)
        with torch.no_grad():
            model.weight[0, 0] += 1.0
        after = probe.state_dict_digest(model)
        self.assertNotEqual(before, after)

    def test_result_classification_boundaries(self) -> None:
        self.assertEqual(
            probe.classify_result(0.50, 0.05, 0.90),
            "execution-representation-contains-linearly-recoverable-operation-information",
        )
        self.assertEqual(
            probe.classify_result(0.01, 0.02, 0.40),
            "operation-identity-not-linearly-represented-in-execution-state",
        )
        self.assertEqual(
            probe.classify_result(0.01, 0.02, 0.95),
            "development-success-untouched-collapse",
        )

    def test_atomic_json_writes_complete_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            probe.atomic_json({"promotion": probe.PROMOTION}, path)
            self.assertIn(probe.PROMOTION, path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
