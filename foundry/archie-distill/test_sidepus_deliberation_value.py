from __future__ import annotations

import unittest
from dataclasses import asdict

import torch

from archie_hybrid_core import PRESETS
from archie_sidepus_organism import ArchieSidepusOrganism, OrganismConfig
from sidepus_pursuit_forward import pursuit_forward


class DeliberationValueTest(unittest.TestCase):
    def test_each_token_thought_has_loss_and_stop_probability(self) -> None:
        values = asdict(PRESETS["micro"])
        values.update(
            plastic_mode="delta",
            plastic_rank=4,
            plastic_retention_floor=0.95,
            plastic_write_scale=0.1,
            plastic_state_clip=2.0,
            plastic_detach_every=32,
            event_size=4,
            state_slots=4,
            state_top_k=1,
            state_quant_bits=8,
            state_aux_weight=0.1,
            action_count=0,
            deliberation_max_steps=4,
            deliberation_ponder_weight=0.0002,
            deliberation_min_halt=0.01,
        )
        model = ArchieSidepusOrganism(OrganismConfig(**values))
        inputs = torch.randint(0, 256, (2, 32), dtype=torch.long)
        result = pursuit_forward(model, inputs, labels=inputs)
        self.assertEqual(tuple(result["deliberation_step_losses"].shape), (4,))
        self.assertEqual(tuple(result["deliberation_token_losses"].shape), (4, 2, 31))
        self.assertEqual(tuple(result["halt_weights"].shape), (2, 32, 4))
        self.assertTrue(torch.allclose(
            result["halt_weights"].sum(dim=-1),
            torch.ones(2, 32),
            atol=1e-5,
        ))
        self.assertTrue(torch.isfinite(result["deliberation_step_losses"]).all())
        self.assertTrue(torch.isfinite(result["deliberation_token_losses"]).all())
        total = result["loss"] + 0.05 * result["deliberation_step_losses"].mean()
        total.backward()
        self.assertIsNotNone(model.deliberation_halt.weight.grad)
        self.assertTrue(torch.isfinite(model.deliberation_halt.weight.grad).all())


if __name__ == "__main__":
    unittest.main()
