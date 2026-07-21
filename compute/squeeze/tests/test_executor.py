from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from squeeze.capsule import JobCapsule
from squeeze.executor import ExecutionPlan, ExecutionRejected, prepare
from squeeze.policy import LocalPolicy
from squeeze.workspace import JobWorkspace


class ExecutorTests(unittest.TestCase):
    def test_campaign_must_be_inside_job_workspace(self) -> None:
        commit = "a" * 40
        capsule = JobCapsule.from_mapping(
            {
                "schema": "squeeze-job-v1",
                "repository": "Pokitomas/theawesomehexapp",
                "source_commit": commit,
                "entrypoint": "foundry/archie-protocol/latent_world_benchmark/research/efficient_terminal_training.py",
                "entrypoint_sha256": "b" * 64,
                "arguments": ["--scale", "base"],
                "environment_profile": "archie-cuda-v1",
                "required_evaluator_sha256": "c" * 64,
                "output_contract": "terminal-efficiency-v3",
                "promotion": "research-only-not-admitted",
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                "nonce": "job-12345678",
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = ExecutionPlan(capsule, JobWorkspace(root / "job"), root / "outside-campaign")
            with self.assertRaises(ExecutionRejected):
                prepare(plan, LocalPolicy(approved_commits=frozenset({commit})))


if __name__ == "__main__":
    unittest.main()
