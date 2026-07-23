#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig
from archie_linked_state import linked_forward
from linked_state_controls import (
    ControlMetrics,
    classify_recurrence,
    clone_state,
    reset_state_like,
    shuffled_state,
    state_digest,
)


class LinkedStateControlsTest(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(1734)
        cfg = ModelConfig(
            d_model=32,
            n_layers=4,
            n_heads=4,
            n_kv_heads=2,
            d_ff=64,
            ssm_expand=1,
            conv_kernel=3,
            attention_every=2,
            attention_window=5,
            max_seq_len=24,
            dropout=0.0,
        )
        model = ArchieHybridLM(cfg).eval()
        tokens = torch.randint(0, 256, (2, 11))
        self.state = linked_forward(model, tokens)["linked_state"]

    def test_clone_preserves_digest(self) -> None:
        self.assertEqual(state_digest(self.state), state_digest(clone_state(self.state)))

    def test_reset_and_shuffle_change_digest(self) -> None:
        original = state_digest(self.state)
        self.assertNotEqual(original, state_digest(reset_state_like(self.state)))
        self.assertNotEqual(original, state_digest(shuffled_state(self.state, 734)))

    def test_shuffle_is_deterministic(self) -> None:
        first = state_digest(shuffled_state(self.state, 734))
        second = state_digest(shuffled_state(self.state, 734))
        self.assertEqual(first, second)

    def test_supported_verdict_requires_all_controls(self) -> None:
        result = classify_recurrence(
            ControlMetrics(
                correct_bpb=1.0,
                reset_bpb=1.1,
                transplant_bpb=1.2,
                shuffled_bpb=1.15,
                ordinary_retention_delta_bpb=0.01,
                incremental_max_logit_error=1e-6,
                seeds=3,
                heldout_sources=8,
            )
        )
        self.assertEqual(result["verdict"], "recurrence-supported")
        self.assertTrue(result["event_clock_unblocked"])

    def test_negative_result_blocks_event_clock(self) -> None:
        result = classify_recurrence(
            ControlMetrics(
                correct_bpb=1.1,
                reset_bpb=1.0,
                transplant_bpb=1.2,
                shuffled_bpb=1.2,
                ordinary_retention_delta_bpb=0.0,
                incremental_max_logit_error=1e-6,
                seeds=3,
                heldout_sources=8,
            )
        )
        self.assertEqual(result["verdict"], "recurrence-not-supported")
        self.assertFalse(result["event_clock_unblocked"])


if __name__ == "__main__":
    unittest.main()
