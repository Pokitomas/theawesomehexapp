#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import unittest

import torch

from train_emergent_policy import (
    Config, EmergentPolicy, PAD, action_vocabulary, compile_episodes,
    make_batch, split_indices,
)


class EmergentPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = dataclasses.replace(
            Config(),
            observation_width=48,
            embedding_width=16,
            convolution_channels=16,
            hidden_width=32,
        )

    def test_forward_and_backward_are_finite_with_padded_steps(self) -> None:
        model = EmergentPolicy(self.config, 5)
        observations = torch.randint(0, 256, (3, 4, self.config.observation_width))
        observations[0, -1].fill_(PAD)
        output = model(observations)

        self.assertEqual(tuple(output["logits"].shape), (3, 4, 5))
        self.assertTrue(bool(torch.isfinite(output["logits"]).all()))
        loss = output["logits"].square().mean() + output["value"].square().mean()
        loss.backward()
        self.assertGreater(sum(parameter.grad is not None for parameter in model.parameters()), 10)

    def test_counterfactual_values_and_group_holdout(self) -> None:
        rows = []
        for index in range(6):
            rows.append(
                {
                    "episode_id": f"episode-{index}",
                    "repository_id": f"repo-{index // 2}",
                    "mechanism_id": f"mechanism-{index % 2}",
                    "task_family": "repair",
                    "steps": [
                        {
                            "observation": f"state {index}",
                            "action": "inspect",
                            "return": 0.2,
                            "stop": False,
                            "teacher_confidence": 1.0,
                            "rejected_actions": [],
                            "counterfactuals": [
                                {
                                    "action": "repair",
                                    "return": 0.9,
                                    "verified": True,
                                    "receipt_digest": "a" * 64,
                                }
                            ],
                        }
                    ],
                }
            )
        vocabulary = action_vocabulary(rows)
        config = dataclasses.replace(self.config, use_counterfactual_head=True)
        episodes = compile_episodes(rows, config, vocabulary)
        train, held, split = split_indices(episodes, 7, "repository_id")
        self.assertEqual(split["axis"], "repository_id")
        train_groups = {episodes[index]["repository_id"] for index in train}
        held_groups = {episodes[index]["repository_id"] for index in held}
        self.assertTrue(train_groups.isdisjoint(held_groups))
        batch = make_batch(episodes, [0, 1], len(vocabulary), torch.device("cpu"))
        action_returns, action_return_mask = batch[-2:]
        self.assertEqual(int(action_return_mask.sum()), 4)
        model = EmergentPolicy(config, len(vocabulary))
        output = model(batch[0])
        self.assertEqual(tuple(output["action_value"].shape), (2, 1, len(vocabulary)))
        loss = output["action_value"][action_return_mask].sub(
            action_returns[action_return_mask]
        ).square().mean()
        loss.backward()


if __name__ == "__main__":
    unittest.main()
