#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

import latent_world_benchmark as base
import full_budget_campaign as campaign
import research.operation_information_probe as diagnostic
import research.operation_recovery_training as recovery


class OperationRecoveryTrainingTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.set_num_threads(1)
        self.cfg = campaign.scale_by_name("base").world
        self.registry = recovery.semantic_operation_registry()

    def test_registry_has_all_declared_labels_and_unique_signatures(self) -> None:
        self.assertEqual(self.registry.shape, (base.N_OPS, base.N_PRIMITIVES + 4))
        self.assertEqual(torch.unique(self.registry, dim=0).size(0), base.N_OPS)
        self.assertTrue(torch.all((self.registry == 0) | (self.registry == 1)))

    def test_registry_matches_generated_ordinary_operations(self) -> None:
        signatures, labels, _ = recovery.collect_training_signatures(
            self.cfg,
            seed=8081,
            batches=24,
            batch_size=64,
        )
        audit = recovery.validate_registry(signatures, labels, self.registry)
        self.assertTrue(audit["valid"])
        self.assertEqual(audit["mismatches"], 0)
        self.assertEqual(audit["labels"], list(range(9)))

    def test_shared_bit_encoder_generalizes_to_never_positive_columns(self) -> None:
        generator = torch.Generator().manual_seed(19)
        train = torch.randint(0, 2, (4096, 13), generator=generator).float()
        train[:, -2:] = 0.0
        model, _, _, _ = recovery.fit_recovery_adapter(
            train,
            seed=22,
            steps=250,
            batch_size=512,
            learning_rate=1e-2,
            hidden=8,
        )
        test = torch.tensor([
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
            [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1],
        ], dtype=torch.float32)
        predicted = model(test).sigmoid().ge(0.5)
        self.assertTrue(predicted.eq(test.bool()).all())

    def test_nearest_registry_decoder_recovers_held_out_labels(self) -> None:
        logits = (self.registry[[9, 10]] * 2.0 - 1.0) * 12.0
        decoded = recovery.decode_operation_labels(logits, self.registry)
        self.assertEqual(decoded.tolist(), [9, 10])

    def test_registry_digest_is_stable(self) -> None:
        self.assertEqual(
            recovery.registry_sha256(self.registry),
            recovery.registry_sha256(recovery.semantic_operation_registry()),
        )


if __name__ == "__main__":
    unittest.main()
