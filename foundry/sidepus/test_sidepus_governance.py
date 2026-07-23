#!/usr/bin/env python3
"""Authority-boundary tests for Sidepus worker distribution."""
from __future__ import annotations

import pathlib
import tempfile
import unittest

from .catalog import Catalog
from .governance import bind_pending_jobs, current_content_policy_digest
from .governed_cli import _verify_worker_policy


def policy(name: str) -> dict[str, object]:
    return {
        "schema": "sidepus-content-policy/v2",
        "approved_by_operator": True,
        "purposes": [name],
        "historical_sources": ["contract-test"],
        "fresh_capture": False,
        "languages": ["en"],
        "time_ranges": [{"from": "2000", "to": "2026"}],
        "subject_allocations": {name: 1.0},
        "exclusions": [],
        "maximum_archive_bytes": 1 << 20,
    }


class SidepusGovernanceTest(unittest.TestCase):
    def test_worker_requires_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / "worker"
            with Catalog(state):
                pass
            with self.assertRaises(ValueError):
                _verify_worker_policy(state, "0" * 64)

    def test_worker_policy_must_match_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / "worker"
            with Catalog(state) as catalog:
                catalog.install_policy("content", policy("worker"))
            with self.assertRaises(ValueError):
                _verify_worker_policy(state, "0" * 64)

    def test_every_worker_job_must_be_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / "worker"
            with Catalog(state) as catalog:
                digest = catalog.install_policy("content", policy("shared"))
                catalog.enqueue_jobs([{
                    "source_id": "test",
                    "adapter": "test",
                    "kind": "local-archive-object",
                    "locator": {"path": "/not-executed"},
                }])
            with self.assertRaises(ValueError):
                _verify_worker_policy(state, digest)
            with Catalog(state) as catalog:
                self.assertEqual(bind_pending_jobs(catalog, digest), 1)
            _verify_worker_policy(state, digest)

    def test_policy_digest_is_stable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / "worker"
            with Catalog(state) as catalog:
                installed = catalog.install_policy("content", policy("stable"))
                self.assertEqual(current_content_policy_digest(catalog), installed)


if __name__ == "__main__":
    unittest.main()
