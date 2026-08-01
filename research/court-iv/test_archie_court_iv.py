#!/usr/bin/env python3
"""Contract tests for the ARCHIE Court IV falsifiers.

Dependency-light: standard library only, no numpy, no torch, no GPU.

Run: python research/court-iv/test_archie_court_iv.py
"""

from __future__ import annotations

import math
import pathlib
import random
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import archie_court_iv as court  # noqa: E402
import archie_semidirect as arch  # noqa: E402


class TransitionAlgebra(unittest.TestCase):
    """The shipped law must be exactly what the audit says it is."""

    def test_composition_matches_sequential_application(self):
        rng = random.Random(7)
        for _ in range(200):
            a = arch.Event(*[rng.uniform(-0.5, 0.5) for _ in range(7)])._replace(
                q=rng.uniform(0.1, 0.99)
            )
            b = arch.Event(*[rng.uniform(-0.5, 0.5) for _ in range(7)])._replace(
                q=rng.uniform(0.1, 0.99)
            )
            state = [rng.uniform(-2, 2) for _ in range(3)]
            stepwise = arch.apply_event(a, arch.apply_event(b, state))
            composed = arch.apply_event(arch.compose(a, b), state)
            self.assertLess(arch.max_abs_difference(stepwise, composed), 1e-12)

    def test_composition_is_noncommutative_through_the_z_term(self):
        a = arch.Event(0.9, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0)
        b = arch.Event(0.9, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0)
        forward = arch.compose(a, b)
        reverse = arch.compose(b, a)
        # z21 = z2 + z1 + x2 y1, so the two orders differ by exactly x*y.
        self.assertAlmostEqual(forward.z - reverse.z, 0.2 * 0.2, places=12)

    def test_identity_is_neutral(self):
        rng = random.Random(11)
        event = arch.Event(0.7, 0.1, -0.2, 0.05, 0.3, -0.4, 0.9)
        self.assertLess(arch.event_difference(arch.compose(event, arch.IDENTITY), event), 1e-15)
        self.assertLess(arch.event_difference(arch.compose(arch.IDENTITY, event), event), 1e-15)
        del rng

    def test_shipped_normalizer_is_a_strict_contraction(self):
        """||q N||_inf <= c sigma(a) < c < 1 for every reachable coefficient."""
        rng = random.Random(13)
        ceilings = arch.retention_rate_ceilings(16)
        for _ in range(2000):
            ceiling = ceilings[rng.randrange(16)]
            raw = [rng.gauss(0.0, 6.0) for _ in range(7)]
            event = arch.event_from_coefficients(raw, ceiling)
            self.assertLessEqual(arch.operator_norm_inf(event), ceiling + 1e-12)
            self.assertLess(arch.operator_norm_inf(event), 1.0)

    def test_all_three_scans_agree(self):
        rng = random.Random(17)
        ceilings = arch.retention_rate_ceilings(4)
        events = [
            arch.event_from_coefficients(court.random_coefficients(rng), ceilings[i % 4])
            for i in range(64)
        ]
        serial = arch.prefix_serial(events)
        hillis = arch.prefix_hillis_steele(events)
        tree = arch.prefix_binary_tree(events)
        for s, h, t in zip(serial, hillis, tree):
            self.assertLess(arch.event_difference(s, h), 1e-12)
            self.assertLess(arch.event_difference(s, t), 1e-12)


class SolverDepth(unittest.TestCase):
    """The shipped recurrence is affine in the state, so beta is structurally zero."""

    def test_archie_needs_exactly_one_correction_round(self):
        for steps in (64, 256, 1024):
            step, jac, dim = court._archie_system(steps, seed=3)
            rounds, history = court.newton_rounds(step, jac, dim, steps, [0.0] * dim)
            self.assertEqual(rounds, 1, f"length {steps} took {rounds} rounds")
            self.assertLess(history[0], court.NEWTON_TOLERANCE)

    def test_archie_jacobian_does_not_depend_on_state(self):
        step, jac, _ = court._archie_system(32, seed=5)
        left = jac([0.0, 0.0, 0.0], 7)
        right = jac([12.0, -30.0, 4.5], 7)
        for row_a, row_b in zip(left, right):
            self.assertLess(arch.max_abs_difference(row_a, row_b), 1e-15)
        del step

    def test_nonlinear_comparator_actually_needs_more_rounds(self):
        """Guards against a solver so lax that every system looks like Lane A."""
        step, jac, dim = court._residual_tanh_system(256, seed=2000)
        rounds, _ = court.newton_rounds(step, jac, dim, 256, [0.0] * dim)
        self.assertGreater(rounds, 1)


class CancellationCertificate(unittest.TestCase):
    def test_proposed_scalar_merge_is_not_associative(self):
        result = court.experiment_cancellation_certificate(trials=200)
        self.assertGreater(
            result["proposed_scalar_monoid"]["nonzero_associativity_gap_fraction"], 0.99
        )

    def test_repair_a_is_associative(self):
        result = court.experiment_cancellation_certificate(trials=200)
        self.assertTrue(result["repair_a_log_semiring"]["is_associative"])

    def test_repair_a_bound_is_conservative_never_optimistic(self):
        """A safety certificate that under-reports is worse than useless."""
        result = court.experiment_cancellation_certificate(trials=200)
        self.assertGreaterEqual(
            result["repair_a_log_semiring"]["median_bound_looseness_two_factors"], 1.0
        )


class GrowthPenalty(unittest.TestCase):
    def test_penalty_is_zero_when_growth_is_within_target(self):
        self.assertEqual(court.growth_penalty(4.0, 8.0, 1.0), 0.0)
        self.assertEqual(court.growth_penalty(4.0, 4.0, 0.0), 0.0)
        self.assertEqual(court.growth_penalty(8.0, 4.0, 0.0), 0.0)

    def test_penalty_is_positive_when_growth_exceeds_target(self):
        self.assertGreater(court.growth_penalty(4.0, 8.0, 0.0), 0.0)
        self.assertAlmostEqual(
            court.growth_penalty(4.0, 8.0, 0.0), math.log(2.0), places=12
        )

    def test_penalty_is_vacuous_for_the_shipped_model(self):
        """One round at every length means the term can never fire."""
        for beta_target in (0.0, 0.3, 0.61):
            self.assertEqual(court.growth_penalty(1.0, 1.0, beta_target), 0.0)

    def test_block_record_excludes_the_refuted_scalar_monoid(self):
        record = court.block_record(1e-9, [1.0, 0.1, 0.01], 3, 0.0)
        self.assertNotIn("cancellation_number", record)
        self.assertEqual(len(record["per_round_contraction"]), 2)
        self.assertAlmostEqual(record["mean_contraction"], 0.1, places=12)


class MemoryTransportTrade(unittest.TestCase):
    def test_initialization_horizon_is_far_below_the_training_window(self):
        ceiling = math.exp(-arch.RETENTION_RATE_MIN)
        q = arch.normalizer_shipped(ceiling, arch.RETENTION_BIAS, 0.0, 0.0, 0.0)
        self.assertLess(arch.half_life(q), 50.0)
        self.assertLess(q**512, 1e-4)

    def test_raising_the_retention_bias_restores_initial_horizon(self):
        ceiling = math.exp(-arch.RETENTION_RATE_MIN)
        shipped = arch.normalizer_shipped(ceiling, 4.0, 0.0, 0.0, 0.0)
        proposed = arch.normalizer_shipped(ceiling, 8.0, 0.0, 0.0, 0.0)
        self.assertGreater(arch.half_life(proposed), 8 * arch.half_life(shipped))

    def test_full_transport_collapses_memory_under_the_shipped_normalizer(self):
        ceiling = math.exp(-arch.RETENTION_RATE_MIN)
        saturated = arch.normalizer_shipped(
            ceiling, 30.0, arch.TRANSPORT_SCALE, arch.TRANSPORT_SCALE, arch.TRANSPORT_SCALE
        )
        self.assertLess(arch.effective_horizon(saturated), 3.0)

    def test_no_fiber_can_span_the_training_window(self):
        """The linspace lower bound alone caps the horizon below 512."""
        self.assertLess(1.0 / arch.RETENTION_RATE_MIN, 512.0)

    def test_scale_free_transport_bounds_every_fiber_alike(self):
        """tau_i = kappa lambda_i makes the prefix-norm bound fiber-independent."""
        bounds = []
        for lam in (0.002, 0.005, 0.01, 0.05, 0.1):
            transport = arch.scale_free_transport(lam, kappa=1.0)
            best = max(
                arch.saturated_prefix_norm(math.exp(-lam), transport, k)
                for k in range(1, int(20 / lam), max(1, int(1 / lam) // 20))
            )
            bounds.append(best)
        self.assertLess(max(bounds) / min(bounds), 1.15)
        self.assertLess(max(bounds), 2.0)

    def test_decoupled_normalizer_stays_bounded_but_with_a_large_constant(self):
        """Honest failure mode: removing the penalty outright is safe but loose."""
        best = max(
            arch.saturated_prefix_norm(math.exp(-0.002), arch.TRANSPORT_SCALE, k)
            for k in range(1, 6000, 25)
        )
        self.assertGreater(best, 100.0)
        self.assertLess(best, 1e6)


class ParameterAccounting(unittest.TestCase):
    def test_reconstruction_matches_the_audited_total(self):
        result = court.experiment_parameter_accounting()
        self.assertTrue(result["matches"])
        self.assertEqual(result["reconstructed_total"], court.AUDITED_PARAMETER_TOTAL)

    def test_coefficient_head_dominates_capacity(self):
        result = court.experiment_parameter_accounting()
        share = result["share_of_parameters"]["coefficient_output"]
        self.assertGreater(share, 0.45)


class ClaimBoundary(unittest.TestCase):
    """This repository does not permit capability claims from structural evidence."""

    def test_harness_makes_no_capability_claim(self):
        text = (pathlib.Path(__file__).resolve().parent / "archie_court_iv.py").read_text()
        # "lane admission" is Court III's own routing vocabulary and is allowed;
        # promotion vocabulary about the checkpoint's quality is not.
        for forbidden in (
            "state of the art",
            "outperforms",
            "production ready",
            "beats the baseline",
            "model is admitted",
        ):
            self.assertNotIn(forbidden, text.lower())
        self.assertIn("claim_boundary", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
