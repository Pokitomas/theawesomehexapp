#!/usr/bin/env python3
"""Dependency-free contract for the causal-divergence CUDA execution bridge."""
from __future__ import annotations
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
METHOD = "verifier-anchored-causal-divergence-qlora/v1"
POLICY_ONLY_OBJECTIVE = "policy-only-causal-margin/v1"


class CudaCausalWorkflowContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / ".github/workflows/archie-cuda-training.yml").read_text(encoding="utf-8")
        cls.docs = (ROOT / "docs/archie-cuda-training-actions.md").read_text(encoding="utf-8")
        cls.request = json.loads((ROOT / ".github/training/archie-cuda-request.json").read_text(encoding="utf-8"))
        cls.profile = json.loads((ROOT / "maker/evaluations/archie-causal-divergence-qwen3-quality.json").read_text(encoding="utf-8"))

    def test_request_binds_merged_method_and_issue(self):
        self.assertEqual(self.request["schema"], "archie-cuda-training-request/v2")
        self.assertEqual(self.request["method"], METHOD)
        self.assertEqual(self.request["issue_number"], 583)
        self.assertEqual(self.request["baseline_commit"], "8bb6fac2809afcc55f91f900bc6bf16f84dfb788")
        self.assertEqual(self.request["promotion"], "not-admitted")

    def test_profile_is_budgeted_higher_capacity_and_not_placeholder(self):
        training = self.profile["training"]
        self.assertEqual(training["method"], METHOD)
        self.assertEqual(training["objective"], POLICY_ONLY_OBJECTIVE)
        self.assertTrue(training["use_rslora"])
        self.assertGreaterEqual(training["lora_rank"], 24)
        self.assertLess(training["token_budget_fraction"], 1.0)
        self.assertFalse(training["inline_evaluation"])
        self.assertFalse(training["gradient_checkpointing"])
        self.assertEqual(self.profile["student"]["revision"], "8d4744f9e13072f4920c326350fa81eedb74eae9")
        self.assertNotIn("replace-with", json.dumps(self.profile))
        self.assertGreaterEqual(self.profile["footprint"]["recommended_gpu_vram_bytes"], 12_000_000_000)

    def test_workflow_routes_only_the_requested_neural_method(self):
        for marker in (
            "foundry/archie-distill/compile_causal_pairs.py",
            "foundry/archie-distill/train_causal_divergence.py",
            "ARCHIE_TRAJECTORY_BATCH_PATH",
            "archie-neural-causal-divergence-training-receipt/v1",
            "archie-cuda-actions-causal-training-receipt/v1",
            METHOD,
        ):
            self.assertIn(marker, self.workflow)
        self.assertNotIn('foundry/archie-distill/train.py \\\n', self.workflow)

    def test_workflow_remains_fail_closed(self):
        for marker in (
            "ARCHIE_CUDA_RUNNER_READY !== '1'",
            "repository-owner actor",
            "refusing CPU fallback",
            "receipt.get('promotion') != 'not-admitted'",
            "runs-on: [self-hosted, linux, x64,",
        ):
            self.assertIn(marker, self.workflow)

    def test_docs_state_the_real_workaround_and_boundary(self):
        self.assertIn("ephemeral Linux GPU host", self.docs)
        self.assertIn("cannot be converted into a CUDA trainer by software", self.docs)
        self.assertIn("POK-48 and POK-66", self.docs)
        self.assertIn("separate retrieval/graph/external-memory research lane", self.docs)


if __name__ == "__main__":
    unittest.main()
