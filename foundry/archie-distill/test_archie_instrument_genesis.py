#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import json
import pathlib
import random
import tempfile
import unittest

import numpy as np

import archie_instrument_genesis as ig


class InstrumentGenesisTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = ig.profile_config("smoke")
        self.obs = np.asarray(
            [
                [0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, -0.8],
                [0.2, -0.1, 0.1, 0.5, -0.4, 0.4, 0.6, -0.7],
                [0.4, 0.0, -0.1, 0.6, -0.2, 0.2, 0.5, -0.5],
                [0.7, 0.2, -0.3, 0.7, 0.0, 0.0, 0.3, -0.2],
                [0.9, 0.4, -0.4, 0.5, 0.2, -0.2, 0.1, 0.0],
            ],
            dtype=np.float64,
        )
        self.actions = np.asarray([0, 1, 2, 1], dtype=np.int64)

    def validate(self, program: ig.Program, program_inputs: int = 0) -> dict:
        return ig.validate_program(
            program,
            obs_channels=self.cfg.obs_channels,
            actions=self.cfg.actions,
            program_inputs=program_inputs,
            max_nodes=self.cfg.max_nodes,
            max_cost=self.cfg.max_cost,
            max_window=self.cfg.max_window,
        )

    def test_parse_and_serialization_round_trip(self) -> None:
        program = ig.make_program(
            [
                {"op": "obs", "channel": 0, "lag": 0},
                {"op": "rolling_mean", "args": [0], "window": 3},
                {"op": "diff", "args": [1], "lag": 1},
                {"op": "threshold", "args": [2], "level": 0.1},
                {"op": "accumulate", "args": [2, 3], "decay": 0.7},
            ],
            4,
            parents=["parent-a"],
            history=[{"operator": "unit"}],
            generation=1,
        )
        self.validate(program)
        encoded = ig.canonical_json(program.serialize())
        loaded = ig.Program.from_dict(json.loads(encoded))
        self.assertEqual(encoded, ig.canonical_json(loaded.serialize()))
        self.assertEqual(program.semantic_hash(), loaded.semantic_hash())

    def test_deterministic_execution_and_finite_bounds(self) -> None:
        program = ig.make_program(
            [
                {"op": "projection", "channels": [0, 1, 2], "weights": [0.7, -0.4, 0.2], "lag": 0},
                {"op": "rolling_std", "args": [0], "window": 3},
                {"op": "threshold", "args": [1], "level": 0.05},
                {"op": "fsm", "args": [0], "low": -0.2, "high": 0.2},
                {"op": "conditional", "args": [2, 3, 0]},
            ],
            4,
        )
        self.validate(program)
        executor = ig.ProgramExecutor(program, self.cfg.obs_channels, self.cfg.actions)
        first = executor.run(self.obs, self.actions)
        second = executor.run(self.obs.copy(), self.actions.copy())
        np.testing.assert_array_equal(first, second)
        self.assertTrue(np.isfinite(first).all())
        self.assertLessEqual(float(np.max(np.abs(first))), 1.0)

    def test_mutations_and_crossovers_remain_valid(self) -> None:
        rng = random.Random(991)
        parent = ig.random_program(rng, self.cfg)
        for _ in range(40):
            child = ig.mutate_program(parent, rng, self.cfg)
            validation = self.validate(child)
            self.assertLessEqual(validation["cost"], self.cfg.max_cost)
            self.assertTrue(child.parents)
            self.assertTrue(child.mutation_history)
            parent = child
        other = ig.random_program(rng, self.cfg)
        crossed = ig.crossover_program(parent, other, rng, self.cfg)
        self.validate(crossed)
        self.assertEqual(set(crossed.parents), {parent.uid, other.uid})

    def test_cost_bound_rejects_oversized_program(self) -> None:
        nodes = [{"op": "obs", "channel": 0, "lag": 0}]
        for index in range(self.cfg.max_nodes - 1):
            nodes.append({"op": "fsm", "args": [index], "low": -0.1, "high": 0.1})
        program = ig.make_program(nodes, len(nodes) - 1)
        with self.assertRaises(ValueError):
            self.validate(program)

    def test_raw_interface_and_arbitrary_execution_restrictions(self) -> None:
        privileged = ig.make_program([{"op": "obs", "channel": 0, "lag": 0, "hidden_state": "x"}], 0)
        with self.assertRaises(ValueError):
            self.validate(privileged)
        arbitrary = ig.make_program([{"op": "python_eval", "source": "1+1"}], 0)
        with self.assertRaises(ValueError):
            self.validate(arbitrary)
        spec = ig.make_world_spec(73, self.cfg)
        world = ig.RawWorld(spec)
        observation = world.reset(88)
        next_observation, consequence = world.step(1)
        self.assertEqual(observation.shape, (self.cfg.obs_channels,))
        self.assertEqual(next_observation.shape, (self.cfg.obs_channels,))
        self.assertIsInstance(consequence, float)
        self.assertFalse(hasattr(observation, "state"))

    def test_channel_remapping_preserves_execution(self) -> None:
        old_perm = tuple(range(self.cfg.obs_channels))
        new_perm = (2, 0, 3, 1, 4, 7, 5, 6)
        program = ig.make_program(
            [
                {"op": "obs", "channel": 2, "lag": 0},
                {"op": "obs", "channel": 6, "lag": 1},
                {"op": "interaction", "args": [0, 1]},
            ],
            2,
        )
        remapped = ig.remap_program(program, old_perm, new_perm)
        self.validate(remapped)
        exposed_old = self.obs.copy()
        exposed_new = self.obs[:, list(new_perm)]
        old_output = ig.ProgramExecutor(program, self.cfg.obs_channels, self.cfg.actions).run(exposed_old, self.actions)
        new_output = ig.ProgramExecutor(remapped, self.cfg.obs_channels, self.cfg.actions).run(exposed_new, self.actions)
        np.testing.assert_allclose(old_output, new_output, atol=0.0, rtol=0.0)

    def test_parentage_survives_serialization(self) -> None:
        rng = random.Random(33)
        parent = ig.random_program(rng, self.cfg)
        child = ig.mutate_program(parent, rng, self.cfg)
        loaded = ig.Program.from_dict(child.serialize())
        self.assertIn(parent.uid, loaded.parents)
        self.assertGreaterEqual(len(loaded.mutation_history), 1)
        self.assertGreater(loaded.generation, parent.generation)

    def test_ablation_wiring_contains_exact_conditions(self) -> None:
        cfg = dataclasses.replace(
            self.cfg,
            episode_length=12,
            train_episodes=2,
            eval_episodes=1,
            history=3,
            policy_horizon=1,
            rollout_horizon=1,
        )
        spec = ig.make_world_spec(91, cfg)
        train = ig.collect_dataset(spec, cfg, cfg.train_episodes, 101)
        evaluation = ig.collect_dataset(spec, cfg, cfg.eval_episodes, 202)
        program = ig.make_program(
            [
                {"op": "obs", "channel": 0, "lag": 0},
                {"op": "diff", "args": [0], "lag": 1},
            ],
            1,
        )
        provider = ig.ProgramFeatureProvider(cfg, [program])
        _, model = ig.evaluate_condition("full", train, evaluation, provider, spec, cfg, 303)
        ablations = ig.run_ablations([program], spec, train, evaluation, cfg, 404, model)
        required = {
            "remove_program",
            "zero_output",
            "shuffle_across_episodes",
            "shuffle_across_time",
            "complexity_matched_random",
            "replace_with_parent",
            "syntactically_similar_behavioral_mutant",
            "retrain_without",
            "freeze_downstream_remove",
            "constant_output",
            "metadata_removed_execution_preserved",
            "metadata_preserved_execution_removed",
        }
        self.assertTrue(required.issubset(ablations))
        self.assertEqual(ablations["zero_output"]["feature_width"], 1)
        self.assertEqual(ablations["freeze_downstream_remove"]["parameter_count"], model.weights.size)

    def test_teacher_lock_semantics(self) -> None:
        verdicts = {
            "instrument_admission": True,
            "causal_dependence": True,
            "cross_world_transport": True,
            "fecundity": True,
            "revision": True,
            "retention_reconstruction": True,
        }
        smoke_lock = ig.teacher_lock_state(self.cfg, verdicts)
        self.assertEqual(smoke_lock["full_teacher_entry"], "prohibited")
        full_lock = ig.teacher_lock_state(ig.profile_config("full"), verdicts)
        self.assertEqual(full_lock["full_teacher_entry"], "unlocked")
        proposal = ig.make_program([{"op": "obs", "channel": 0, "lag": 0}], 0)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            proposal_path = root / "proposal.json"
            receipt_path = root / "receipt.json"
            proposal_path.write_text(json.dumps([proposal.serialize()]), encoding="utf-8")
            receipt_path.write_text(json.dumps({"teacher_lock": smoke_lock}), encoding="utf-8")
            with self.assertRaises(PermissionError):
                ig.load_teacher_proposals(proposal_path, receipt_path)
            receipt_path.write_text(json.dumps({"teacher_lock": full_lock}), encoding="utf-8")
            loaded = ig.load_teacher_proposals(proposal_path, receipt_path)
            self.assertEqual(loaded[0].origin, "teacher")

    def test_sealed_world_declared_post_selection_and_smoke_cannot_unlock(self) -> None:
        cfg = dataclasses.replace(
            self.cfg,
            episode_length=10,
            train_episodes=2,
            eval_episodes=1,
            development_worlds=1,
            population_size=6,
            generations=1,
            offspring_per_generation=2,
            elite_count=3,
            admitted_width=2,
            history=3,
            policy_horizon=1,
            rollout_horizon=1,
            fecundity_budget=2,
            revision_budget=2,
        )
        with tempfile.TemporaryDirectory() as directory:
            receipt = ig.run_experiment(cfg, pathlib.Path(directory), 17)
            sealed = [world for world in receipt["worlds"] if world["role"] == "sealed_post_selection"]
            self.assertEqual(len(sealed), 1)
            self.assertTrue(sealed[0]["instantiated_after_selection"])
            self.assertEqual(receipt["verdict"]["structural_implementation"], "passed")
            self.assertEqual(receipt["teacher_lock"]["full_teacher_entry"], "prohibited")
            self.assertFalse(receipt["teacher_lock"]["teacher_free_proof_bundle_passed"])


if __name__ == "__main__":
    unittest.main()
