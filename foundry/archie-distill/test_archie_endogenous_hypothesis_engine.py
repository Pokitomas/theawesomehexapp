#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_endogenous_hypothesis_engine import CausalWorld, Config, Hypothesis, choose_action


class EndogenousHypothesisEngineTest(unittest.TestCase):
    def test_world_returns_only_observation_transition(self) -> None:
        cfg = Config(device="cpu", seeds=(17,))
        world = CausalWorld(cfg, 17)
        before = world.reset(29)
        after = world.intervene(3)
        self.assertEqual(before.shape, (cfg.variables,))
        self.assertEqual(after.shape, (cfg.variables,))
        self.assertTrue(torch.isfinite(after).all())

    def test_hypothesis_predicts_next_observation_and_latent(self) -> None:
        cfg = Config(width=32, latent=8, ensemble=3, device="cpu", seeds=(17,))
        model = Hypothesis(cfg)
        state = torch.randn(5, cfg.variables)
        action = torch.randint(0, cfg.actions, (5,))
        prediction, latent = model(state, action)
        self.assertEqual(prediction.shape, state.shape)
        self.assertEqual(latent.shape, (5, cfg.latent))

    def test_experiment_selector_returns_valid_intervention(self) -> None:
        cfg = Config(width=32, latent=8, ensemble=3, candidate_actions=12,
                     device="cpu", seeds=(17,))
        models = [Hypothesis(cfg) for _ in range(cfg.ensemble)]
        action = choose_action(models, torch.zeros(cfg.variables), cfg, __import__("random").Random(17))
        self.assertGreaterEqual(action, 0)
        self.assertLess(action, cfg.actions)


if __name__ == "__main__":
    unittest.main()
