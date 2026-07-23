#!/usr/bin/env python3
from __future__ import annotations

import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from gate import evaluate_recurrence_gate, read_json, validate_protocol


class EventClockGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.protocol_path = pathlib.Path(__file__).with_name("protocol.json")
        cls.protocol = read_json(cls.protocol_path)
        cls.thresholds = validate_protocol(cls.protocol)

    def passing_report(self) -> dict:
        return {
            "schema": "archie-linked-recurrence-report/v1",
            "verified": True,
            "promotion": "research-only-not-admitted",
            "baseline_model_sha256": "a" * 64,
            "fixed_eval_receipt_sha256": "b" * 64,
            "seeds": [
                {
                    "seed": seed,
                    "carried_bpb": 2.00,
                    "reset_bpb": 2.03,
                    "transplanted_bpb": 2.04,
                    "shuffled_bpb": 2.04,
                    "maximum_logit_parity_error": 0.00001,
                    "ordinary_retention_regression_bpb": 0.005,
                }
                for seed in (735, 1735, 2735)
            ],
        }

    def test_passing_report_authorizes_only_candidate_creation(self) -> None:
        result = evaluate_recurrence_gate(self.passing_report(), self.thresholds)
        self.assertTrue(result["authorized"])
        self.assertEqual(result["failures"], [])

    def test_reset_tie_blocks(self) -> None:
        report = self.passing_report()
        report["seeds"][0]["reset_bpb"] = report["seeds"][0]["carried_bpb"]
        result = evaluate_recurrence_gate(report, self.thresholds)
        self.assertFalse(result["authorized"])
        self.assertIn("seed-735-carried-state-gain-failed", result["failures"])

    def test_transplant_insensitivity_blocks(self) -> None:
        report = self.passing_report()
        report["seeds"][1]["transplanted_bpb"] = report["seeds"][1]["carried_bpb"]
        result = evaluate_recurrence_gate(report, self.thresholds)
        self.assertIn("seed-1735-transplant-penalty-failed", result["failures"])

    def test_parity_or_retention_failure_blocks(self) -> None:
        report = self.passing_report()
        report["seeds"][2]["maximum_logit_parity_error"] = 0.01
        report["seeds"][2]["ordinary_retention_regression_bpb"] = 0.2
        result = evaluate_recurrence_gate(report, self.thresholds)
        self.assertIn("seed-2735-incremental-parity-failed", result["failures"])
        self.assertIn("seed-2735-ordinary-retention-failed", result["failures"])

    def test_protocol_digest_is_fail_closed(self) -> None:
        protocol = copy.deepcopy(self.protocol)
        protocol["scale"]["maximum_parameters"] = 114_000_000
        with self.assertRaises(ValueError):
            validate_protocol(protocol)


if __name__ == "__main__":
    unittest.main()
