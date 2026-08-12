#!/usr/bin/env python3
from __future__ import annotations

import math
import unittest

import motor_consequence_memory_court as C


class MotorConsequenceMemoryCourt(unittest.TestCase):
    def test_design_uses_history_before_current_consequence(self):
        rows = [
            {"motor_action": {"kind": "mkdir"}, "observed_delta": {"created_files": 0, "created_dirs": 1, "deleted_files": 0, "deleted_dirs": 0, "changed_files": 0, "byte_delta": 0}},
            {"motor_action": {"kind": "mkdir"}, "observed_delta": {"created_files": 0, "created_dirs": 1, "deleted_files": 0, "deleted_dirs": 0, "changed_files": 0, "byte_delta": 0}},
        ]
        x, y, states = C.design(rows, decays=(0.5,), updater=C.linear_update)
        self.assertEqual(states[0], (0.0,))
        self.assertEqual(x[0][-1:], [0.0])
        self.assertGreater(states[1][0], 0.0)
        self.assertEqual(y[0], y[1])

    def test_state_cost_decision_is_separate_from_court_validity(self):
        result = C.run_court(seeds=(56,), steps=96)
        self.assertTrue(result["court_valid"])
        self.assertFalse(result["promotion"])
        aggregate = result["aggregate"]
        self.assertIn("minimal_followup", aggregate)
        self.assertIn(aggregate["minimal_followup"], ("action-only", "linear-one-pole", "linear-two-pole"))
        self.assertEqual(result["dynamic_state_scalars"]["linear_one_pole"], 1)
        self.assertEqual(result["dynamic_state_scalars"]["linear_two_pole"], 2)
        self.assertEqual(result["dynamic_state_scalars"]["nonlinear_two_state"], 2)

    def test_chronological_metrics_are_finite_and_replay_exact(self):
        result = C.run_court(seeds=(56,), steps=96)
        run = result["runs"][0]
        self.assertTrue(run["deterministic_replay_exact"])
        for arm in ("action_only", "linear_one_pole", "linear_two_pole", "nonlinear_two_state"):
            self.assertTrue(math.isfinite(run[arm]["test_mse"]))
        self.assertEqual(run["linear_one_pole"]["test_rows"], run["linear_two_pole"]["test_rows"])
        self.assertEqual(run["linear_two_pole"]["test_rows"], run["nonlinear_two_state"]["test_rows"])

    def test_decay_search_budget_is_explicit(self):
        self.assertEqual(len(list(C.decay_choices(1))), len(C.DECAYS))
        self.assertEqual(len(list(C.decay_choices(2))), 15)
        with self.assertRaises(ValueError):
            list(C.decay_choices(3))

    def test_promotion_remains_false_regardless_of_minimal_followup(self):
        result = C.run_court(seeds=(56,), steps=96)
        self.assertFalse(result["promotion"])
        self.assertIn("counterfactual action-value", result["interpretation"].lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
