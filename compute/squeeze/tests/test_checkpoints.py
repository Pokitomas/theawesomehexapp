from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from squeeze.checkpoints import RunIdentity, ResumeIdentityError, read_checkpoint_metadata, write_checkpoint_metadata


def identity(**changes: str) -> RunIdentity:
    values = {
        "source_commit": "a" * 40,
        "entrypoint_sha256": "b" * 64,
        "evaluator_sha256": "c" * 64,
        "job_capsule_sha256": "d" * 64,
        "training_config_sha256": "e" * 64,
        "campaign_manifest_sha256": "f" * 64,
        "environment_profile": "archie-cuda-v1",
        "output_contract": "terminal-efficiency-v3",
        "promotion": "research-only-not-admitted",
    }
    values.update(changes)
    return RunIdentity(**values)


class CheckpointTests(unittest.TestCase):
    def test_matching_identity_resumes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = identity()
            write_checkpoint_metadata(root, expected, optimizer_steps=64, event_tokens=4096, allocation_rung=1, resume_count=0, state_file="state.pt")
            metadata = read_checkpoint_metadata(root, expected)
            self.assertEqual(metadata["optimizer_steps"], 64)

    def test_changed_evaluator_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_checkpoint_metadata(root, identity(), optimizer_steps=64, event_tokens=4096, allocation_rung=1, resume_count=0, state_file="state.pt")
            with self.assertRaises(ResumeIdentityError):
                read_checkpoint_metadata(root, identity(evaluator_sha256="0" * 64))

    def test_changed_config_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_checkpoint_metadata(root, identity(), optimizer_steps=64, event_tokens=4096, allocation_rung=1, resume_count=0, state_file="state.pt")
            with self.assertRaises(ResumeIdentityError):
                read_checkpoint_metadata(root, identity(training_config_sha256="1" * 64))


if __name__ == "__main__":
    unittest.main()
