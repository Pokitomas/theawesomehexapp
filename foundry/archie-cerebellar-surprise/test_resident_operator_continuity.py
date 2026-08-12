#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest

from resident_operator_continuity import (
    ResidentOperatorKernel,
    make_kernel,
    run_continuity_court,
)


class ResidentOperatorContinuityCourt(unittest.TestCase):
    def test_renderer_text_has_no_operator_authority(self):
        left = make_kernel("same-objective")
        right = make_kernel("same-objective")
        self.assertEqual(
            left.next_operator(renderer_text="Continue exact action court"),
            right.next_operator(renderer_text="How can I help you today?"),
        )
        self.assertEqual(left.snapshot_bytes(), right.snapshot_bytes())

    def test_stagnant_familiar_repeat_triggers_alternative_by_second_repeat(self):
        kernel = make_kernel("stagnant")
        first = kernel.record_consequence(
            [1.0, 0.0], [0.0, 0.0],
            objective_progress_delta=0.0,
            semantic_repeat_count=1,
            renderer_text="What interests you?",
        )
        second = kernel.record_consequence(
            [1.0, 0.0], [0.0, 0.0],
            objective_progress_delta=0.0,
            semantic_repeat_count=2,
            renderer_text="What interests you?",
        )
        self.assertEqual(first["decision"], "retry_once")
        self.assertEqual(second["decision"], "motor_babble_alternative")
        self.assertNotIn(b"What interests you?", kernel.snapshot_bytes())

    def test_productive_repetition_is_not_suppressed(self):
        kernel = make_kernel("productive")
        receipt = kernel.record_consequence(
            [1.0, 0.0], [0.0, 0.0],
            objective_progress_delta=0.1,
            semantic_repeat_count=100,
            renderer_text="generic assistant",
        )
        self.assertEqual(receipt["decision"], "continue_objective")
        self.assertEqual(kernel.objective.cursor, 1)

    def test_surprising_stall_is_inspected_before_random_exploration(self):
        kernel = make_kernel("unexpected")
        receipt = kernel.record_consequence(
            [1.0, 0.0], [1.0, -1.0],
            objective_progress_delta=0.0,
            semantic_repeat_count=2,
        )
        self.assertEqual(receipt["decision"], "inspect_or_learn_consequence")
        self.assertGreater(receipt["novelty_gate"], kernel.adapter.familiar_novelty_max)

    def test_restart_preserves_operator_cursor_and_memory_exactly(self):
        kernel = make_kernel("restart")
        kernel.record_consequence(
            [1.0, 0.0], [0.5, 0.0],
            objective_progress_delta=0.2,
        )
        payload = kernel.snapshot_bytes()
        restored = ResidentOperatorKernel.from_snapshot_bytes(payload)
        self.assertEqual(payload, restored.snapshot_bytes())
        self.assertEqual(
            kernel.next_operator(renderer_text="rich"),
            restored.next_operator(renderer_text="default distribution"),
        )

    def test_adapter_adds_no_ei_dynamic_traces(self):
        kernel = make_kernel("state-tax")
        self.assertEqual(kernel.adapter.added_dynamic_trace_count, 0)
        snap = kernel.snapshot()
        self.assertIn("homeostatic_memory", snap)
        self.assertNotIn("e", snap["policy"])
        self.assertNotIn("i", snap["policy"])

    def test_full_court_passes_strict_json(self):
        result = run_continuity_court()
        json.dumps(result, sort_keys=True, allow_nan=False)
        self.assertTrue(result["pass"])
        self.assertEqual(result["promotion"], "developmental-integration-only")
        self.assertTrue(result["checks"]["renderer_fallback_cannot_change_operator_trajectory"])
        self.assertTrue(result["checks"]["no_added_ei_dynamic_traces"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
