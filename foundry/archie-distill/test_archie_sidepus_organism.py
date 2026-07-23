#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_sidepus_organism import ArchieSidepusOrganism, OrganismConfig


class ArchieSidepusOrganismTests(unittest.TestCase):
    def config(self, **updates: object) -> OrganismConfig:
        values = dict(
            vocab_size=260,
            d_model=64,
            n_layers=2,
            n_heads=4,
            n_kv_heads=2,
            d_ff=128,
            ssm_expand=2,
            ssm_chunk_size=16,
            conv_kernel=3,
            attention_every=2,
            attention_window=32,
            mixer_mode="hybrid",
            plastic_mode="delta",
            plastic_rank=4,
            plastic_retention_floor=0.8,
            plastic_write_scale=0.2,
            plastic_state_clip=2.0,
            plastic_detach_every=8,
            dropout=0.0,
            max_seq_len=32,
            rope_base=10000.0,
            event_size=4,
            state_slots=4,
            state_top_k=1,
            state_quant_bits=8,
            state_aux_weight=0.2,
            action_count=3,
            deliberation_max_steps=3,
            deliberation_ponder_weight=0.001,
            deliberation_min_halt=0.05,
        )
        values.update(updates)
        return OrganismConfig(**values)

    def test_joint_state_forward_backward_and_carry(self) -> None:
        torch.manual_seed(4)
        model = ArchieSidepusOrganism(self.config())
        tokens = torch.randint(0, 255, (2, 24), dtype=torch.long)
        first = model(tokens, labels=tokens, return_diagnostics=True)
        self.assertEqual(tuple(first["world_state"].shape), (2, 4, 64))
        self.assertEqual(tuple(first["plastic_state"].shape), (2, 4, 64))
        self.assertEqual(tuple(first["action_logits"].shape), (2, 3))
        self.assertTrue(1.0 <= float(first["expected_deliberation_steps"]) <= 3.0)
        first["loss"].backward()
        gradients = [p.grad for p in model.parameters() if p.grad is not None]
        self.assertTrue(gradients)
        self.assertTrue(all(torch.isfinite(g).all() for g in gradients))
        model.eval()
        with torch.no_grad():
            reset = model(tokens)["logits"]
            carried = model(
                tokens,
                world_state=first["world_state"],
                plastic_state=first["plastic_state"],
            )["logits"]
        self.assertGreater(float((reset - carried).abs().mean()), 0.0)

    def test_q4_state_is_finite(self) -> None:
        model = ArchieSidepusOrganism(self.config(state_quant_bits=4, action_count=0))
        tokens = torch.randint(0, 255, (1, 16), dtype=torch.long)
        result = model(tokens, labels=tokens, return_diagnostics=True)
        self.assertTrue(torch.isfinite(result["loss"]))
        self.assertTrue(torch.isfinite(result["world_state"]).all())


if __name__ == "__main__":
    unittest.main()
