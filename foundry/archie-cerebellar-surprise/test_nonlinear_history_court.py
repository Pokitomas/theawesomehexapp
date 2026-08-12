#!/usr/bin/env python3
from __future__ import annotations

import unittest

import nonlinear_history_court as N


class NonlinearHistoryCourt(unittest.TestCase):
    def test_exact_two_ema_collision_has_nullspace_witness(self):
        plus, minus, null = N.histories()
        self.assertEqual(N.dual_linear_state(plus), N.dual_linear_state(minus))
        self.assertEqual(N.dual_linear_state(plus), (N.Fraction(15, 16), N.Fraction(175, 128)))
        self.assertEqual(tuple(null), (N.Fraction(8), N.Fraction(-10), N.Fraction(3), N.Fraction(0)))

    def test_equal_size_nonlinear_bank_separates_the_alias(self):
        result = N.run_court()
        self.assertTrue(result["pass"])
        self.assertFalse(result["promotion"])
        self.assertTrue(result["checks"]["linear_bank_aliases_histories_exactly"])
        self.assertTrue(result["checks"]["nonlinear_bank_separates_aliased_histories"])
        self.assertTrue(result["checks"]["same_state_scalar_count"])
        self.assertGreater(
            result["nonlinear_two_state_bank"]["linf_state_separation"],
            1e-4,
        )
        self.assertGreater(
            result["nonlinear_two_state_bank"]["ei_differential_separation"],
            1e-4,
        )

    def test_deterministic_replay_and_bounded_inputs(self):
        result = N.run_court()
        self.assertTrue(result["checks"]["deterministic_replay_exact"])
        self.assertTrue(result["checks"]["inputs_are_bounded"])
        self.assertTrue(result["histories"]["same_last_pulse"])
        self.assertTrue(result["histories"]["all_pulses_in_unit_interval"])

    def test_interpretation_refuses_utility_claim(self):
        result = N.run_court()
        text = result["interpretation"].lower()
        self.assertIn("representational separation", text)
        self.assertIn("does not prove", text)
        self.assertIn("action/consequence", text)
        self.assertFalse(result["promotion"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
