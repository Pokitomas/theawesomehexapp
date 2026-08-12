#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import random
import unittest

from cerebellar_surprise import (
    CerebellarSurpriseBank,
    TraceConfig,
    action_loop_gate,
    affine_saturating_closed_form,
    affine_saturating_step,
    baseline_court,
    run_reference_court,
    scalar_value_counterexample,
    transition_keys,
)


class CerebellarSurpriseCourt(unittest.TestCase):
    def test_affine_saturation_is_exactly_an_affine_filter(self):
        rng = random.Random(20260811)
        a = b = 0.173
        tau = 2.43
        base = 0.0444
        for _ in range(1000):
            gap = rng.randint(1, 17)
            decay = math.exp(-gap / tau)
            a = affine_saturating_step(a, decay, base, 1.0)
            b = affine_saturating_closed_form(b, decay, base, 1.0)
            self.assertAlmostEqual(a, b, places=14)

    def test_analytic_region_gives_one_event_novelty_then_habituation(self):
        cfg = TraceConfig()
        self.assertGreater(cfg.initial_novelty(), 0.0)
        self.assertLessEqual(cfg.steady_novelty(), 0.0)
        self.assertTrue(cfg.supports_one_event_then_habituation())
        bank = CerebellarSurpriseBank(cfg)
        scores = [bank.observe("same", i).novelty for i in range(1, 40)]
        self.assertGreater(scores[0], 0.0)
        self.assertLess(scores[-1], 0.0)
        self.assertLess(scores[-1], scores[0])

    def test_deviant_spikes_same_event_and_repeated_deviant_adapts(self):
        bank = CerebellarSurpriseBank()
        familiar = [bank.observe("familiar", i).novelty for i in range(1, 30)]
        first = bank.observe("deviant", 30).novelty
        repeats = [bank.observe("deviant", i).novelty for i in range(31, 60)]
        self.assertGreater(first, 0.0)
        self.assertGreater(first, familiar[-1])
        self.assertLess(repeats[-1], 0.0)
        self.assertLess(repeats[-1], first)

    def test_transition_address_separates_order_from_symbol_novelty(self):
        bank = CerebellarSurpriseBank()
        idx = 0
        normal = []
        for _ in range(12):
            for key in transition_keys(("A", "B", "C", "A")):
                idx += 1
                normal.append(bank.observe(key, idx).novelty)
        idx += 1
        deviant = bank.observe(("A", "C"), idx).novelty
        self.assertGreater(deviant, 0.0)
        self.assertGreater(deviant, normal[-1])

    def test_save_restore_replay_is_byte_deterministic(self):
        left = CerebellarSurpriseBank()
        for i, key in enumerate(("a", "b", "a", "c", "a"), start=1):
            left.observe(key, i)
        payload = left.snapshot_bytes()
        right = CerebellarSurpriseBank.from_snapshot_bytes(payload)
        self.assertEqual(payload, right.snapshot_bytes())
        self.assertEqual(left.digest(), right.digest())
        l = left.observe("a", 20)
        r = right.observe("a", 20)
        self.assertEqual(l, r)
        self.assertEqual(left.snapshot_bytes(), right.snapshot_bytes())

    def test_scalar_surprise_cannot_rank_interaction_dependent_value(self):
        result = scalar_value_counterexample()
        self.assertTrue(result["same_scalar_novelty"])
        self.assertFalse(result["scalar_can_rank_future_value"])
        values = sorted(result["future_value"].values())
        self.assertEqual(values, [-1.0, 1.0])

    def test_stagnant_dialogue_repeat_breaks_but_useful_repeat_survives(self):
        # Regression for the observed resident loop: "up to you" elicited the
        # same semantic ask repeatedly without objective progress.
        stagnant = action_loop_gate(0.01, 0.0, 2)
        useful = action_loop_gate(0.01, +0.1, 20)
        self.assertTrue(stagnant["suppress_repeated_action"])
        self.assertTrue(stagnant["allow_exploration"])
        self.assertFalse(useful["suppress_repeated_action"])
        self.assertFalse(useful["allow_exploration"])

    def test_cost_ledger_does_not_hide_python_overhead(self):
        bank = CerebellarSurpriseBank()
        bank.observe("x", 1)
        ledger = bank.cost_ledger()
        self.assertEqual(ledger["packed_algorithmic_bytes_per_key"], 24)
        self.assertEqual(ledger["packed_algorithmic_bytes_total"], 24)
        self.assertGreater(
            ledger["python_object_lower_bound_bytes_per_key_excluding_key_and_hash_table"],
            24,
        )
        self.assertEqual(ledger["reference_ops_per_event"]["exp"], 2)

    def test_matched_baselines_fail_closed(self):
        result = baseline_court(TraceConfig())
        self.assertTrue(result["dual_ema"]["identity_with_restricted_affine_ei"])
        self.assertLessEqual(result["dual_ema"]["max_abs_equivalence_error"], 1e-12)
        self.assertTrue(result["simple_unseen_event"]["ei_dominated_by_one_trace_on_this_task"])
        self.assertTrue(result["order_perturbation"]["all_detect_same_event"])
        self.assertEqual(result["order_perturbation"]["normal_prediction_error_tail"], [0.0] * 6)

    def test_reference_court_passes_but_refuses_promotion(self):
        result = run_reference_court()
        # Strict JSON is also a serialization court: NaN/Infinity are forbidden.
        encoded = json.dumps(result, sort_keys=True, allow_nan=False)
        self.assertTrue(encoded)
        self.assertTrue(result["pass"])
        self.assertFalse(result["promotion"])
        self.assertIn("NO_PROMOTION", result["promotion_reason"])
        self.assertGreaterEqual(len(result["falsified_claims"]), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
