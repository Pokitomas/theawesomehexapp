#!/usr/bin/env python3
"""Torch-only gradient tests for both causal-divergence objectives."""
from __future__ import annotations
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


def load_trainer():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("archie_causal_divergence_train", ROOT / "train_causal_divergence.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CausalDivergenceGradientTest(unittest.TestCase):
    def run_objective(self, objective_mode):
        import torch
        trainer = load_trainer()
        torch.manual_seed(7)
        chosen = torch.randn(1, 6, 17, requires_grad=True)
        rejected = torch.randn(1, 6, 17, requires_grad=True)
        reference_chosen = torch.randn(1, 6, 17) if objective_mode == trainer.REFERENCE_OBJECTIVE else None
        reference_rejected = torch.randn(1, 6, 17) if objective_mode == trainer.REFERENCE_OBJECTIVE else None
        chosen_divergence_labels = torch.tensor([[-100, -100, -100, 3, 4, 5]])
        rejected_divergence_labels = torch.tensor([[-100, -100, -100, 6, 7, 8]])
        chosen_sft_labels = torch.tensor([[-100, 1, 2, 3, 4, 5]])
        loss, metrics = trainer.causal_divergence_loss(
            policy_chosen_logits=chosen,
            policy_rejected_logits=rejected,
            reference_chosen_logits=reference_chosen,
            reference_rejected_logits=reference_rejected,
            chosen_divergence_labels=chosen_divergence_labels,
            rejected_divergence_labels=rejected_divergence_labels,
            chosen_sft_labels=chosen_sft_labels,
            evidence_weight=torch.tensor([2.0]),
            beta=0.1,
            margin=0.2,
            sft_weight=0.35,
            objective_mode=objective_mode,
        )
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertIsNotNone(chosen.grad)
        self.assertIsNotNone(rejected.grad)
        self.assertGreater(float(chosen.grad.abs().sum()), 0)
        self.assertGreater(float(rejected.grad.abs().sum()), 0)
        self.assertIn("causal_margin", metrics)

    def test_reference_objective_backpropagates_through_both_arms(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch is not installed")
        trainer = load_trainer()
        self.run_objective(trainer.REFERENCE_OBJECTIVE)

    def test_policy_only_objective_backpropagates_through_both_arms(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch is not installed")
        trainer = load_trainer()
        self.run_objective(trainer.POLICY_ONLY_OBJECTIVE)


if __name__ == "__main__":
    unittest.main()
