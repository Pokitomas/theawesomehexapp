#!/usr/bin/env python3
"""Torch-only mathematical direction checks for causal-divergence preference loss."""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


def load_trainer():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("archie_causal_divergence_math", ROOT / "train_causal_divergence.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CausalDivergenceLossMathTest(unittest.TestCase):
    def test_better_chosen_margin_reduces_preference_loss(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        trainer = load_trainer()
        labels_chosen = torch.tensor([[-100, -100, 1, 2]])
        labels_rejected = torch.tensor([[-100, -100, 3, 4]])
        sft_labels = labels_chosen.clone()
        reference_chosen = torch.zeros(1, 4, 8)
        reference_rejected = torch.zeros(1, 4, 8)
        neutral_chosen = torch.zeros(1, 4, 8)
        neutral_rejected = torch.zeros(1, 4, 8)
        improved_chosen = neutral_chosen.clone()
        improved_rejected = neutral_rejected.clone()
        improved_chosen[0, 1, 1] = 4
        improved_chosen[0, 2, 2] = 4
        improved_rejected[0, 1, 3] = -4
        improved_rejected[0, 2, 4] = -4

        neutral_loss, _ = trainer.causal_divergence_loss(
            policy_chosen_logits=neutral_chosen,
            policy_rejected_logits=neutral_rejected,
            reference_chosen_logits=reference_chosen,
            reference_rejected_logits=reference_rejected,
            chosen_divergence_labels=labels_chosen,
            rejected_divergence_labels=labels_rejected,
            chosen_sft_labels=sft_labels,
            evidence_weight=torch.tensor([1.0]),
            beta=0.1,
            margin=0.2,
            sft_weight=0.0,
        )
        improved_loss, metrics = trainer.causal_divergence_loss(
            policy_chosen_logits=improved_chosen,
            policy_rejected_logits=improved_rejected,
            reference_chosen_logits=reference_chosen,
            reference_rejected_logits=reference_rejected,
            chosen_divergence_labels=labels_chosen,
            rejected_divergence_labels=labels_rejected,
            chosen_sft_labels=sft_labels,
            evidence_weight=torch.tensor([1.0]),
            beta=0.1,
            margin=0.2,
            sft_weight=0.0,
        )
        self.assertLess(float(improved_loss), float(neutral_loss))
        self.assertGreater(float(metrics["causal_margin"]), 0)


if __name__ == "__main__":
    unittest.main()
