#!/usr/bin/env python3
from __future__ import annotations

from fractions import Fraction
import unittest

import nonlinear_action_consequence_court as A


class NonlinearActionConsequenceCourt(unittest.TestCase):
    def test_matched_linear_bank_is_exactly_blind_on_balanced_modes(self):
        epsilons = (Fraction(1, 100), Fraction(1, 50), Fraction(1, 25))
        self.assertTrue(A.exact_linear_aliases(epsilons))
        for epsilon in epsilons:
            plus, minus = A.history_pair(epsilon)
            self.assertEqual(A.N.dual_linear_state(plus), A.N.dual_linear_state(minus))

    def test_nonlinear_policy_generalizes_to_unseen_magnitudes(self):
        result = A.run_court()
        self.assertTrue(result["pass"])
        self.assertFalse(result["promotion"])
        self.assertEqual(result["nonlinear_two_state_candidate"]["mean_reward"], 1.0)
        self.assertEqual(
            result["matched_linear_two_state_baseline"]["best_deterministic_mean_reward_upper_bound"],
            0.5,
        )
        self.assertEqual(
            result["nonlinear_two_state_candidate"]["extra_objective_progress_vs_matched_linear_upper_bound"],
            0.5,
        )
        self.assertTrue(all(row["reward"] == 1.0 for row in result["nonlinear_two_state_candidate"]["rows"]))

    def test_same_state_count_but_extra_math_is_not_hidden(self):
        result = A.run_court()
        self.assertEqual(result["matched_linear_two_state_baseline"]["state_scalars"], 2)
        self.assertEqual(result["nonlinear_two_state_candidate"]["state_scalars"], 2)
        self.assertTrue(result["checks"]["same_dynamic_state_scalar_count"])

    def test_alternate_linear_bank_blocks_broad_superiority_claim(self):
        counterexample = A.alternate_linear_counterexample()
        self.assertTrue(counterexample["separates_constructed_pair"])
        result = A.run_court()
        self.assertTrue(result["checks"]["broad_linear_superiority_claim_is_refused"])
        self.assertIn("blocks", result["interpretation"])
        self.assertFalse(result["promotion"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
