#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig
from archie_linked_state import initial_linked_state, linked_forward


class LinkedStateContractTest(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(734)
        cfg = ModelConfig(
            d_model=32,
            n_layers=4,
            n_heads=4,
            n_kv_heads=2,
            d_ff=64,
            ssm_expand=1,
            ssm_chunk_size=4,
            conv_kernel=3,
            attention_every=2,
            attention_window=5,
            max_seq_len=32,
            dropout=0.0,
        )
        self.model = ArchieHybridLM(cfg).eval()
        self.tokens = torch.randint(0, 256, (2, 17), dtype=torch.long)

    def test_incremental_logits_match_full_recomputation(self) -> None:
        with torch.no_grad():
            expected = self.model(self.tokens)["logits"]
            actual = linked_forward(self.model, self.tokens)["logits"]
        torch.testing.assert_close(actual, expected, rtol=2e-5, atol=2e-5)

    def test_split_execution_matches_single_linked_pass(self) -> None:
        with torch.no_grad():
            complete = linked_forward(self.model, self.tokens)["logits"]
            first = linked_forward(self.model, self.tokens[:, :7])
            second = linked_forward(
                self.model, self.tokens[:, 7:], state=first["linked_state"]
            )
            split = torch.cat((first["logits"], second["logits"]), dim=1)
        torch.testing.assert_close(split, complete, rtol=2e-5, atol=2e-5)

    def test_document_reset_matches_fresh_state(self) -> None:
        reset = torch.zeros_like(self.tokens, dtype=torch.bool)
        reset[:, 9] = True
        with torch.no_grad():
            reset_run = linked_forward(
                self.model, self.tokens, reset_mask=reset
            )["logits"][:, 9:]
            fresh = linked_forward(self.model, self.tokens[:, 9:])["logits"]
        torch.testing.assert_close(reset_run, fresh, rtol=2e-5, atol=2e-5)

    def test_state_rejects_wrong_batch(self) -> None:
        state = initial_linked_state(self.model, 1, torch.device("cpu"))
        with self.assertRaisesRegex(ValueError, "does not match"):
            linked_forward(self.model, self.tokens, state=state)

    def test_detached_state_has_no_graph(self) -> None:
        self.model.train()
        result = linked_forward(
            self.model, self.tokens[:, :4], detach_state=True
        )
        state = result["linked_state"]
        self.assertFalse(state.position.requires_grad)
        for layer in state.layers:
            for value in vars(layer).values():
                if isinstance(value, torch.Tensor):
                    self.assertFalse(value.requires_grad)


if __name__ == "__main__":
    unittest.main()
