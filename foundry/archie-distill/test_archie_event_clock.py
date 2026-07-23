#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import torch

from archie_event_clock import (
    EventClockConfig,
    EventClockLM,
    model_receipt,
    verify_recurrence_receipt,
)


class EventClockContractTest(unittest.TestCase):
    def test_default_prototype_is_within_small_scale_gate(self) -> None:
        model = EventClockLM(EventClockConfig())
        self.assertGreaterEqual(model.parameter_count(), 20_000_000)
        self.assertLessEqual(model.parameter_count(), 30_000_000)

    def test_forward_exposes_two_clocks_and_losses(self) -> None:
        torch.manual_seed(735)
        cfg = EventClockConfig(
            d_model=32,
            byte_layers=2,
            d_ff=64,
            ssm_expand=1,
            ssm_chunk_size=4,
            conv_kernel=3,
            max_seq_len=24,
            state_delta_dim=8,
            future_horizon=4,
        )
        model = EventClockLM(cfg)
        tokens = torch.randint(0, 256, (2, 16))
        result = model(tokens, tokens)
        self.assertEqual(result["logits"].shape, (2, 16, 260))
        self.assertEqual(result["hard_boundaries"].shape, (2, 16))
        self.assertEqual(result["slow_state"].shape, (2, 16, 32))
        self.assertEqual(result["state_delta"].shape, (2, 16, 8))
        self.assertTrue(torch.isfinite(result["loss"]).item())
        result["loss"].backward()
        self.assertIsNotNone(model.boundary_head.weight.grad)

    def test_negative_recurrence_receipt_blocks_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "archie-linked-state-verdict/v1",
                        "verdict": "recurrence-not-supported",
                        "event_clock_unblocked": False,
                        "promotion": "research-only-not-admitted",
                        "metrics": {"seeds": 3, "heldout_sources": 8},
                    }
                )
            )
            with self.assertRaisesRegex(SystemExit, "remains blocked"):
                verify_recurrence_receipt(path)

    def test_supported_receipt_binds_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "archie-linked-state-verdict/v1",
                        "verdict": "recurrence-supported",
                        "event_clock_unblocked": True,
                        "promotion": "research-only-not-admitted",
                        "metrics": {"seeds": 3, "heldout_sources": 8},
                    },
                    sort_keys=True,
                )
            )
            recurrence = verify_recurrence_receipt(path)
            receipt = model_receipt(EventClockLM(EventClockConfig()), recurrence)
            self.assertEqual(receipt["status"], "gated-prototype-untrained")
            self.assertEqual(
                receipt["recurrence_receipt_sha256"], recurrence["source_sha256"]
            )


if __name__ == "__main__":
    unittest.main()
