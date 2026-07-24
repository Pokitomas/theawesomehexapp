from __future__ import annotations

import unittest

import torch

from archie_sidepus_organism import ArchieSidepusOrganism, OrganismConfig
from sidepus_pursuit_forward import pursuit_forward


class SidepusCausalityCourt(unittest.TestCase):
    def config(self) -> OrganismConfig:
        return OrganismConfig(
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
            max_seq_len=64,
            rope_base=10000.0,
            event_size=4,
            state_slots=4,
            state_top_k=1,
            state_quant_bits=8,
            state_aux_weight=0.2,
            action_count=0,
            deliberation_max_steps=4,
            deliberation_ponder_weight=0.001,
            deliberation_min_halt=0.05,
        )

    def setUp(self) -> None:
        torch.manual_seed(17)
        self.model = ArchieSidepusOrganism(self.config()).eval()
        support = torch.randint(0, 255, (1, 11), dtype=torch.long)
        with torch.no_grad():
            carried = self.model(support)
        self.world = carried["world_state"]
        self.plastic = carried["plastic_state"]
        self.prefix = torch.randint(0, 255, (1, 19), dtype=torch.long)
        self.extended = torch.cat(
            (self.prefix, torch.full((1, 13), 251, dtype=torch.long)), dim=1
        )

    def assert_prefix_equal(self, left: torch.Tensor, right: torch.Tensor) -> None:
        self.assertTrue(
            torch.allclose(left, right, atol=1e-5, rtol=1e-4),
            float((left - right).abs().max()),
        )

    def test_integrated_forward_is_suffix_invariant(self) -> None:
        with torch.no_grad():
            prefix = self.model(
                self.prefix,
                world_state=self.world,
                plastic_state=self.plastic,
                return_diagnostics=True,
            )
            extended = self.model(
                self.extended,
                world_state=self.world,
                plastic_state=self.plastic,
                return_diagnostics=True,
            )
        length = self.prefix.size(1)
        self.assert_prefix_equal(prefix["logits"], extended["logits"][:, :length])
        self.assert_prefix_equal(
            prefix["halt_probabilities"], extended["halt_probabilities"][:, :length]
        )
        self.assert_prefix_equal(
            prefix["thought_sequence"], extended["thought_sequence"][:, :length]
        )

    def test_pursuit_step_losses_are_built_from_causal_thoughts(self) -> None:
        with torch.no_grad():
            prefix = pursuit_forward(
                self.model,
                self.prefix,
                labels=self.prefix,
                world_state=self.world,
                plastic_state=self.plastic,
            )
            extended = pursuit_forward(
                self.model,
                self.extended,
                labels=self.extended,
                world_state=self.world,
                plastic_state=self.plastic,
            )
        length = self.prefix.size(1)
        self.assert_prefix_equal(prefix["logits"], extended["logits"][:, :length])
        self.assert_prefix_equal(
            prefix["halt_weights"], extended["halt_weights"][:, :length]
        )
        self.assert_prefix_equal(
            prefix["deliberation_hidden_steps"],
            extended["deliberation_hidden_steps"][:, :, :length],
        )
        self.assertTrue(torch.allclose(
            prefix["halt_weights"].sum(dim=-1),
            torch.ones_like(prefix["halt_weights"][..., 0]),
            atol=1e-5,
        ))

    def test_reset_path_is_suffix_invariant(self) -> None:
        with torch.no_grad():
            prefix = self.model(self.prefix, return_diagnostics=True)
            extended = self.model(self.extended, return_diagnostics=True)
        self.assert_prefix_equal(
            prefix["logits"], extended["logits"][:, : self.prefix.size(1)]
        )


if __name__ == "__main__":
    unittest.main()
