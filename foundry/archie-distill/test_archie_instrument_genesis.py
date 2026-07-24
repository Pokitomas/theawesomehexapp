#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import unittest

import torch

import archie_instrument_genesis as instrument


class InstrumentGenesisTest(unittest.TestCase):
    def test_program_round_trip_executes_over_raw_history(self) -> None:
        program = instrument.Program(
            "tanh",
            (
                instrument.Program(
                    "sub",
                    (
                        instrument.Program("obs", (3,)),
                        instrument.Program("obs", (2,)),
                    ),
                ),
            ),
        )
        restored = instrument.Program.from_json(program.json())
        self.assertEqual(restored.digest(), program.digest())
        data = instrument.Dataset(
            obs_history=torch.randn(7, 4, 4),
            action_history=torch.randint(0, 5, (7, 3)),
            action=torch.randint(0, 5, (7,)),
            next_obs=torch.randn(7, 4),
            world_family=torch.zeros(7, dtype=torch.long),
            world_id=torch.zeros(7, dtype=torch.long),
        )
        value = instrument.eval_program(restored, data)
        self.assertEqual(value.shape, (7, 4))
        self.assertTrue(torch.isfinite(value).all())

    def test_world_families_are_independent_and_partially_observed(self) -> None:
        cfg = instrument.Config(device="cpu")
        inertial = instrument.InertialWorld(cfg, 17)
        oscillator = instrument.OscillatorWorld(cfg, 17)
        self.assertIsNot(
            instrument.InertialWorld.transition,
            instrument.OscillatorWorld.transition,
        )
        self.assertGreater(inertial.dim, cfg.sensors)
        self.assertGreater(oscillator.dim, cfg.sensors)
        first = inertial.reset(29)
        second = oscillator.reset(29)
        self.assertEqual(first.shape, (cfg.sensors,))
        self.assertEqual(second.shape, (cfg.sensors,))
        self.assertFalse(torch.equal(first, second))

    def test_seed_manifest_keeps_sealed_worlds_out_of_evolution(self) -> None:
        cfg = instrument.profile("full", "cpu")
        manifest = instrument.world_seed_manifest(cfg, 43)
        self.assertTrue(set(manifest["sealed"]).isdisjoint(manifest["train"]))
        self.assertTrue(set(manifest["sealed"]).isdisjoint(manifest["dev"]))
        self.assertTrue(set(manifest["train"]).isdisjoint(manifest["dev"]))

    def test_smoke_budget_cannot_unlock_teacher_entry(self) -> None:
        cfg = dataclasses.replace(
            instrument.profile("smoke", "cpu"),
            seeds=(17, 29, 43),
        )
        runs = [
            {
                "seed": seed,
                "passed": True,
                "program_digests": [f"{seed}-a", f"{seed}-b"],
                "sealed_is_disjoint": True,
            }
            for seed in cfg.seeds
        ]
        receipt = instrument.aggregate(cfg, runs)
        self.assertFalse(receipt["passed_architecture_gate"])
        self.assertEqual(receipt["full_teacher_entry"], "prohibited")
        self.assertFalse(receipt["checks"]["full_declared_budget"])

    def test_full_budget_unlock_requires_three_passing_disjoint_runs(self) -> None:
        cfg = instrument.profile("full", "cpu")
        runs = [
            {
                "seed": seed,
                "passed": True,
                "program_digests": [f"{seed}-a", f"{seed}-b", f"{seed}-c"],
                "sealed_is_disjoint": True,
            }
            for seed in cfg.seeds
        ]
        receipt = instrument.aggregate(cfg, runs)
        self.assertTrue(receipt["passed_architecture_gate"])
        self.assertEqual(receipt["full_teacher_entry"], "unlocked")

    def test_counterfactual_trial_has_no_task_labels(self) -> None:
        cfg = dataclasses.replace(
            instrument.profile("smoke", "cpu"),
            sealed_worlds_per_family=1,
            trajectories_per_world=4,
            steps_per_trajectory=8,
        )
        train = instrument.concat(
            [
                instrument.collect_world(
                    cfg, family, 100 + family, family, 700 + family
                )
                for family in (0, 1)
            ]
        )
        sealed, worlds, snapshots = instrument.collect_sealed_with_snapshots(cfg, 991)
        program = instrument.Program(
            "sub",
            (
                instrument.Program("obs", (3,)),
                instrument.Program("obs", (2,)),
            ),
        )
        models = instrument.fit_family_predictors(train, cfg, [program])
        result = instrument.counterfactual_trial(
            models,
            sealed,
            cfg,
            [program],
            worlds,
            snapshots,
        )
        self.assertEqual(set(result), {"0", "1"})
        self.assertTrue(all(value >= 0.0 for value in result.values()))


if __name__ == "__main__":
    unittest.main()
