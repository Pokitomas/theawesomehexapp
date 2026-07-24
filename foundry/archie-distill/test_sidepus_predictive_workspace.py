from __future__ import annotations

import unittest

import torch

from archie_sidepus_organism import ArchieSidepusOrganism, OrganismConfig


class PredictiveWorkspaceCourt(unittest.TestCase):
    def config(self) -> OrganismConfig:
        return OrganismConfig(
            vocab_size=260, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2,
            d_ff=128, ssm_expand=2, ssm_chunk_size=16, conv_kernel=3,
            attention_every=2, attention_window=32, mixer_mode="hybrid",
            plastic_mode="delta", plastic_rank=4, plastic_retention_floor=0.8,
            plastic_write_scale=0.2, plastic_state_clip=2.0, plastic_detach_every=8,
            dropout=0.0, max_seq_len=64, rope_base=10000.0, event_size=4,
            state_slots=4, state_top_k=1, state_quant_bits=8, state_aux_weight=0.2,
            action_count=0, deliberation_max_steps=4,
            deliberation_ponder_weight=0.001, deliberation_min_halt=0.05,
            state_prediction_weight=0.1, state_surprise_floor=0.1,
            state_surprise_temperature=8.0,
        )

    def test_prediction_error_reaches_persistent_memory_parameters(self) -> None:
        torch.manual_seed(91)
        model = ArchieSidepusOrganism(self.config()).train()
        tokens = torch.randint(0, 255, (2, 24), dtype=torch.long)
        result = model(tokens, labels=tokens, return_diagnostics=True)
        result["loss"].backward()
        self.assertGreater(float(result["state_prediction_loss"]), 0.0)
        self.assertGreater(float(result["state_surprise"]), 0.0)
        self.assertIsNotNone(model.state_predictor.weight.grad)
        self.assertGreater(float(model.state_predictor.weight.grad.abs().sum()), 0.0)
        self.assertIsNotNone(model.state_write_fuse.weight.grad)
        self.assertGreater(float(model.state_write_fuse.weight.grad.abs().sum()), 0.0)

    def test_later_thought_depth_requeries_memory(self) -> None:
        torch.manual_seed(92)
        model = ArchieSidepusOrganism(self.config()).eval()
        tokens = torch.randint(0, 255, (1, 20), dtype=torch.long)
        with torch.no_grad():
            result = model(tokens, return_diagnostics=True)
        retrieval = result["workspace_retrieval_weights"]
        self.assertEqual(tuple(retrieval.shape), (4, 1, 20, 4))
        self.assertTrue(torch.allclose(retrieval.sum(dim=-1), torch.ones_like(retrieval[..., 0])))
        change = (retrieval[1:] - retrieval[:-1]).abs().sum()
        self.assertGreater(float(change), 0.0)

    def test_future_suffix_cannot_change_predictive_workspace_prefix(self) -> None:
        torch.manual_seed(93)
        model = ArchieSidepusOrganism(self.config()).eval()
        prefix = torch.randint(0, 255, (1, 19), dtype=torch.long)
        extended = torch.cat((prefix, torch.full((1, 11), 250, dtype=torch.long)), dim=1)
        with torch.no_grad():
            left = model(prefix, return_diagnostics=True)
            right = model(extended, return_diagnostics=True)
        length = prefix.size(1)
        self.assertTrue(torch.allclose(left["logits"], right["logits"][:, :length], atol=1e-5, rtol=1e-4))
        self.assertTrue(torch.allclose(
            left["workspace_retrieval_weights"],
            right["workspace_retrieval_weights"][:, :, :length],
            atol=1e-5, rtol=1e-4,
        ))


if __name__ == "__main__":
    unittest.main()
