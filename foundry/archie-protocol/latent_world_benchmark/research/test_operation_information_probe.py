#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path

import torch

import latent_world_benchmark as base
import full_budget_campaign as campaign
import research.efficient_terminal_training as terminal
import research.operation_information_probe as probe


class OperationInformationProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.set_num_threads(1)
        self.cfg = campaign.scale_by_name("base").world

    def test_operation_signature_has_primitive_and_flag_bits(self) -> None:
        batch = base.generate_batch(self.cfg, 4, 6, 12345, "train")
        signature = probe.operation_signature(batch["events"], self.cfg)
        self.assertEqual(signature.shape, (4, 6, base.N_PRIMITIVES + 4))
        self.assertTrue(torch.all((signature == 0) | (signature == 1)))

    def test_label_support_audit_preserves_unseen_labels(self) -> None:
        labels = torch.tensor([[0, 1, 9, 10]])
        signatures = torch.tensor([[
            [1, 0, 0],
            [0, 1, 0],
            [1, 1, 0],
            [1, 0, 1],
        ]], dtype=torch.float32)
        audit = probe.label_signature_audit(labels, signatures)
        self.assertEqual(audit["labels"], [0, 1, 9, 10])
        self.assertEqual(audit["examples"], 4)
        self.assertEqual(audit["by_label"]["9"]["unique_signatures"], 1)

    def test_linear_signature_probe_learns_separable_components(self) -> None:
        generator = torch.Generator().manual_seed(77)
        features = torch.randn(2048, 12, generator=generator)
        weights = torch.randn(5, 12, generator=generator)
        targets = (features @ weights.T > 0).float()
        fitted, _, _ = probe.fit_probe(
            features,
            targets,
            seed=991,
            steps=500,
            batch_size=256,
            learning_rate=1e-2,
        )
        metrics = probe.evaluate_probe(fitted, features, targets)
        self.assertGreater(metrics["bit_accuracy"], 0.97)
        self.assertGreater(metrics["exact_signature_accuracy"], 0.85)

    def test_frozen_checkpoint_contract_loads_without_trainable_parameters(self) -> None:
        model = terminal.FullStateFactorizedInterpreter(self.cfg, width=36)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        optimizer.zero_grad(set_to_none=True)
        loss = sum(parameter.square().sum() for parameter in model.parameters())
        loss.backward()
        optimizer.step()
        checkpoint = {
            "schema": terminal.SCHEMA,
            "arm": {"name": "factorized_w36_lr1e3", "kind": "factorized_full_state", "width": 36, "lr": 0.001},
            "world": dataclasses.asdict(self.cfg),
            "seed": 1,
            "steps": 1,
            "state_dict": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "promotion": terminal.PROMOTION,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save(checkpoint, path)
            loaded, loaded_cfg, loaded_checkpoint, digest = probe.load_frozen_model(path, probe.sha256_file(path))
        self.assertEqual(loaded_cfg, self.cfg)
        self.assertEqual(loaded_checkpoint["seed"], 1)
        self.assertEqual(len(digest), 64)
        self.assertTrue(all(not parameter.requires_grad for parameter in loaded.parameters()))


if __name__ == "__main__":
    unittest.main()
