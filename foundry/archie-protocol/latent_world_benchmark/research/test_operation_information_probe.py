#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

import torch

import latent_world_benchmark as base
from operation_information_probe import (
    balanced_indices,
    classification_metrics,
    tensor_state_sha256,
    train_linear_probe,
    verify_sha256_inventory,
    wilson_interval,
)


class OperationInformationProbeTests(unittest.TestCase):
    def test_inventory_accepts_artifact_root_prefixed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact_root = Path(temporary)
            terminal_root = artifact_root / "artifacts" / "terminal-efficiency-v3"
            terminal_root.mkdir(parents=True)
            payload = terminal_root / "checkpoint.pt"
            payload.write_bytes(b"checkpoint")
            digest = hashlib.sha256(payload.read_bytes()).hexdigest()
            (terminal_root / "SHA256SUMS").write_text(
                f"{digest}  artifacts/terminal-efficiency-v3/checkpoint.pt\n",
                encoding="utf-8",
            )
            verify_sha256_inventory(terminal_root)

    def test_balancing_preserves_every_operation_class(self) -> None:
        labels = torch.tensor([0, 0, 0, 1, 1, 2, 2, 2, 2])
        indices = balanced_indices(labels, classes=3, seed=41)
        selected = labels[indices]
        self.assertEqual([int(selected.eq(class_id).sum()) for class_id in range(3)], [2, 2, 2])

    def test_tensor_digest_is_order_stable_and_value_sensitive(self) -> None:
        left = {"b": torch.tensor([2.0]), "a": torch.tensor([1.0])}
        right = {"a": torch.tensor([1.0]), "b": torch.tensor([2.0])}
        changed = {"a": torch.tensor([1.0]), "b": torch.tensor([3.0])}
        self.assertEqual(tensor_state_sha256(left), tensor_state_sha256(right))
        self.assertNotEqual(tensor_state_sha256(left), tensor_state_sha256(changed))

    def test_wilson_interval_contains_observed_fraction(self) -> None:
        lower, upper = wilson_interval(90, 100)
        self.assertLess(lower, 0.9)
        self.assertGreater(upper, 0.9)

    def test_classification_metrics_preserve_confusion_geometry(self) -> None:
        logits = torch.tensor([[5.0, 0.0], [0.0, 5.0], [5.0, 0.0]])
        labels = torch.tensor([0, 1, 1])
        metrics = classification_metrics(logits, labels)
        self.assertEqual(metrics["correct"], 2)
        self.assertEqual(metrics["confusion_matrix"], [[1, 0], [1, 1]])

    def test_linear_probe_learns_separable_latent(self) -> None:
        torch.manual_seed(7)
        features = torch.cat([torch.randn(64, 4) - 3.0, torch.randn(64, 4) + 3.0])
        labels = torch.cat([torch.zeros(64, dtype=torch.long), torch.ones(64, dtype=torch.long)])
        original_classes = base.N_OPS
        try:
            base.N_OPS = 2
            probe, optimizer, history = train_linear_probe(
                features,
                labels,
                seed=9,
                steps=96,
                learning_rate=0.05,
                weight_decay=1e-4,
            )
            self.assertGreaterEqual(float(probe(features).argmax(-1).eq(labels).float().mean()), 0.99)
            self.assertTrue(optimizer.state_dict()["state"])
            self.assertEqual(history[-1]["step"], 96)
        finally:
            base.N_OPS = original_classes


if __name__ == "__main__":
    unittest.main()
