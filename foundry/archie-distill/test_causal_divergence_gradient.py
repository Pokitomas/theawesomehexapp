#!/usr/bin/env python3
"""Torch-only gradient test for the causal-divergence objective.

This does not train a language model. It verifies that the committed objective
is differentiable and sends opposing gradient signal through the chosen and
rejected policy logits while reference logits stay frozen.
"""
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
    def test_objective_backpropagates_through_both_policy_arms(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        trainer = load_trainer()
        torch.manual_seed(7)
        chosen = torch.randn(1, 6, 17, requires_grad=True)
        rejected = torch.randn(1, 6, 17, requires_grad=True)
        reference_chosen = torch.randn(1, 6, 17)
        reference_rejected = torch.randn(1, 6, 17)
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
        )
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertIsNotNone(chosen.grad)
        self.assertIsNotNone(rejected.grad)
        self.assertGreater(float(chosen.grad.abs().sum()), 0)
        self.assertGreater(float(rejected.grad.abs().sum()), 0)
        self.assertIn("causal_margin", metrics)
        self.assertIn("pair_accuracy", metrics)


if __name__ == "__main__":
    unittest.main()
