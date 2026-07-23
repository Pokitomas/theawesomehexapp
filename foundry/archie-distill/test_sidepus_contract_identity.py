from __future__ import annotations

import unittest
from types import SimpleNamespace

import torch

from archie_hybrid_core import PRESETS
from archie_sidepus_organism import OrganismConfig
from sidepus_pursuit_objectives import CONTRACT_SCHEMA, pursuit_contract


class PursuitContractIdentityTest(unittest.TestCase):
    def test_deliberation_curriculum_is_contract_bound(self) -> None:
        args = SimpleNamespace(
            cache_dir="/tmp/cache",
            cache_bytes=1024,
            pursuit_lookahead=8,
            prefetch_workers=1,
            counterfactual_every=4,
            state_margin=0.01,
            state_order_weight=0.5,
            deliberation_compute_cost=0.002,
            deliberation_policy_weight=0.05,
            deliberation_trajectory_weight=0.2,
            deliberation_improvement_margin=0.002,
            deliberation_halt_warmup_steps=75,
            deliberation_floor_weight=0.05,
            halt_entropy_weight=0.001,
            interference_every=8,
            interference_weight=0.1,
            retention_tax_weight=2.0,
            learning_rate=2e-4,
            language_lr_scale=0.05,
            max_steps=100,
            warmup_steps=10,
            grad_clip=1.0,
            seed=17,
        )
        cfg = OrganismConfig(**PRESETS["micro"].__dict__, event_size=4, state_slots=4, state_top_k=1)
        plan = {
            "plan_sha256": "a" * 64,
            "receipt_digest": "b" * 64,
            "inventory_sha256": "c" * 64,
        }
        retention = {"sha256": "d" * 64}
        contract = pursuit_contract(
            args,
            cfg,
            "e" * 64,
            plan,
            retention,
            torch.device("cpu"),
            None,
        )
        self.assertEqual(contract["schema"], CONTRACT_SCHEMA)
        self.assertEqual(contract["pursuit"]["deliberation_improvement_margin"], 0.002)
        self.assertEqual(contract["pursuit"]["deliberation_halt_warmup_steps"], 75)


if __name__ == "__main__":
    unittest.main()
