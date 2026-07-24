#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_counterfactual_state_probe import CounterfactualStateProbe, ProbeConfig, pair_swap
from archie_counterfactual_observed_world import generate_observed_twins


class CounterfactualStateProbeTest(unittest.TestCase):
    def test_twins_share_query_and_differ_only_at_one_intervention(self) -> None:
        cfg = ProbeConfig(width=32, slots=4, top_k=1, batch_size=8, steps=1, seeds=(1,), eval_batches=1, device="cpu")
        batch = generate_observed_twins(cfg=cfg, pairs=4, events=9, seed=17)
        for index in range(0, 8, 2):
            self.assertEqual(int(batch.query_ids[index]), int(batch.query_ids[index + 1]))
            self.assertNotEqual(int(batch.answers[index]), int(batch.answers[index + 1]))
            self.assertTrue(torch.equal(batch.object_ids[index], batch.object_ids[index + 1]))
            self.assertTrue(torch.equal(batch.op_ids[index], batch.op_ids[index + 1]))
            differences = batch.value_ids[index].ne(batch.value_ids[index + 1]).nonzero().flatten()
            self.assertEqual(differences.numel(), 1)
            self.assertEqual(int(differences[0]), int(batch.intervention_index[index]))

    def test_reset_logits_are_identical_inside_each_twin_pair(self) -> None:
        cfg = ProbeConfig(width=32, slots=4, top_k=1, batch_size=8, steps=1, seeds=(1,), eval_batches=1, device="cpu")
        model = CounterfactualStateProbe(cfg)
        batch = generate_observed_twins(cfg=cfg, pairs=4, events=7, seed=31)
        reset = model.state.initial_state(batch.query_ids.numel(), torch.device("cpu"))
        logits, _ = model.query(batch.query_ids, reset)
        pairs = logits.view(-1, 2, logits.size(-1))
        self.assertTrue(torch.equal(pairs[:, 0], pairs[:, 1]))

    def test_pair_swap_is_an_involution(self) -> None:
        state = torch.arange(48).reshape(6, 2, 4)
        self.assertTrue(torch.equal(pair_swap(pair_swap(state)), state))
        self.assertTrue(torch.equal(pair_swap(state)[0], state[1]))


if __name__ == "__main__":
    unittest.main()
