#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_hybrid_core import ModelConfig
from archie_recurrent_state import (
    RecurrentArchieHybridLM,
    RecurrentState,
    detach_state,
    shuffle_state_channels,
    state_from_lists,
    transplant_state,
)


class RecurrentStateTests(unittest.TestCase):
    def model(self) -> RecurrentArchieHybridLM:
        torch.manual_seed(11)
        cfg = ModelConfig(
            d_model=32,
            n_layers=3,
            n_heads=4,
            n_kv_heads=2,
            d_ff=64,
            ssm_expand=2,
            ssm_chunk_size=8,
            conv_kernel=3,
            attention_every=2,
            attention_window=16,
            max_seq_len=64,
            dropout=0.0,
        )
        model = RecurrentArchieHybridLM(cfg)
        model.eval()
        return model

    def test_full_and_incremental_logits_match(self) -> None:
        model = self.model()
        tokens = torch.randint(0, 256, (2, 12))
        with torch.no_grad():
            full = model(tokens)["logits"]
            pieces = []
            ssm = kv = None
            for index in range(tokens.size(1)):
                logits, ssm, kv = model.step(tokens[:, index:index + 1], ssm, kv)
                pieces.append(logits)
            incremental = torch.cat(pieces, dim=1)
        torch.testing.assert_close(full, incremental, rtol=2e-4, atol=2e-5)

    def test_document_reset_matches_fresh_suffix(self) -> None:
        model = self.model()
        prefix = torch.randint(0, 256, (2, 7))
        suffix = torch.randint(0, 256, (2, 5))
        _, ssm, kv = model.step(prefix)
        reset = torch.ones(2, dtype=torch.bool)
        carried, _, _ = model.step(suffix, ssm, kv, reset_mask=reset)
        fresh, _, _ = model.step(suffix)
        torch.testing.assert_close(carried, fresh, rtol=2e-4, atol=2e-5)

    def test_transplant_and_shuffle_change_state(self) -> None:
        model = self.model()
        tokens = torch.randint(0, 256, (2, 8))
        _, ssm, kv = model.step(tokens)
        state = state_from_lists(ssm, kv)
        transplanted = transplant_state(state, torch.tensor([1, 0]))
        self.assertFalse(torch.equal(state.ssm[0].recurrent, transplanted.ssm[0].recurrent))
        generator = torch.Generator().manual_seed(9)
        shuffled = shuffle_state_channels(state, generator)
        self.assertEqual(shuffled.ssm[0].recurrent.shape, state.ssm[0].recurrent.shape)

    def test_detach_removes_graph(self) -> None:
        model = self.model()
        model.train()
        tokens = torch.randint(0, 256, (1, 5))
        _, ssm, kv = model.step(tokens)
        state = detach_state(RecurrentState(ssm, kv))
        for item in state.ssm:
            if item is not None:
                self.assertFalse(item.recurrent.requires_grad)
                self.assertFalse(item.convolution.requires_grad)


if __name__ == "__main__":
    unittest.main()
