#!/usr/bin/env python3
"""End-to-end dependency-free test of causal pair compilation."""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


def load_compiler():
    spec = importlib.util.spec_from_file_location("archie_compile_causal_pairs", ROOT / "compile_causal_pairs.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CompileCausalPairsTest(unittest.TestCase):
    def test_compilation_is_deterministic_and_group_split(self):
        compiler = load_compiler()
        parent = {
            "trajectory_digest": "a" * 64,
            "request": "repair repository",
            "subject": "repo",
            "provenance": {"repository": "x/y", "base_sha": "1" * 40},
            "events": [{"sequence": 2, "type": "plan", "payload": {"action": "unsafe"}}],
            "verification": [{"status": "failed", "independent": True, "evidence_digest": "f" * 64}],
            "outcome": {"status": "failed", "negative": True},
        }
        repair = {
            "trajectory_digest": "b" * 64,
            "parent_trajectory_digest": parent["trajectory_digest"],
            "request": parent["request"],
            "subject": "repo",
            "provenance": {"repository": "x/y", "base_sha": "1" * 40},
            "events": [{"sequence": 2, "type": "plan", "payload": {"action": "verified"}}],
            "verification": [{"status": "passed", "independent": True, "evidence_digest": "e" * 64}],
            "outcome": {"status": "completed", "negative": False},
        }
        admissions = [
            {"trajectory_digest": parent["trajectory_digest"], "admitted": True, "negative": True, "admission_digest": "c" * 64},
            {"trajectory_digest": repair["trajectory_digest"], "admitted": True, "positive": True, "admission_digest": "d" * 64},
        ]
        body = {
            "schema": "archie-trajectory-batch/v1",
            "trajectories": [parent, repair],
            "admissions": admissions,
        }
        batch = {**body, "batch_digest": compiler.digest(body)}
        with tempfile.TemporaryDirectory() as directory:
            batch_path = pathlib.Path(directory) / "batch.json"
            batch_path.write_text(__import__("json").dumps(batch), encoding="utf-8")
            first = compiler.compile_pairs([batch_path], seed=3407, holdout_rate=0.2)
            second = compiler.compile_pairs([batch_path], seed=3407, holdout_rate=0.2)
        self.assertEqual(first, second)
        train, development, receipt = first
        self.assertEqual(len(train) + len(development), 1)
        self.assertEqual(receipt["counts"]["total"], 1)
        body = dict(receipt)
        claimed = body.pop("receipt_digest")
        self.assertEqual(claimed, compiler.digest(body))


if __name__ == "__main__":
    unittest.main()
