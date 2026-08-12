#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-local-semantic-broker-v2.py"
SPEC = importlib.util.spec_from_file_location("archie_local_semantic_broker_v2_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


class GroundingCourt(unittest.TestCase):
    def test_missing_proof_fail_closes(self):
        with tempfile.TemporaryDirectory() as td:
            text = M.compact_capability_proof(pathlib.Path(td) / "missing.json")
            self.assertIn("unavailable", text)
            self.assertIn("UNPROVED", text)

    def test_projection_contains_backend_state_but_not_secret_values(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "proof.json"
            proof = {
                "generated_unix_ns": time.time_ns(),
                "receipt_sha256": "a" * 64,
                "services": {
                    "archie-live-exec.service": {
                        "active_state": "active",
                        "main_pid": 123,
                        "pid_alive": True,
                        "credential_env_names": {"OPENAI_API_KEY": True},
                        "imaginary_secret_value": "DO_NOT_PROJECT_ME",
                    }
                },
                "listeners": {
                    "tcp_8788_8789": ["LISTEN 127.0.0.1:8788"],
                    "presence_socket": {"exists": True},
                },
                "gpu": {"gpus": ["0, RTX TEST, 3000, 6144, 55"]},
                "git": {"is_git": True, "branch": "court", "head": "b" * 40, "dirty": False},
            }
            p.write_text(json.dumps(proof), "utf-8")
            text = M.compact_capability_proof(p)
            self.assertIn("fresh", text)
            self.assertIn("archie-live-exec.service", text)
            self.assertIn("pid=123", text)
            self.assertIn("presence_socket_exists=True", text)
            self.assertNotIn("DO_NOT_PROJECT_ME", text)
            self.assertNotIn("OPENAI_API_KEY", text)

    def test_stale_receipt_cannot_be_sold_as_current(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "proof.json"
            p.write_text(json.dumps({
                "generated_unix_ns": int((time.time() - M.MAX_PROOF_AGE_S - 5) * 1e9),
                "receipt_sha256": "c" * 64,
                "services": {"x.service": {"active_state": "active", "main_pid": 5, "pid_alive": True}},
            }), "utf-8")
            text = M.compact_capability_proof(p)
            self.assertIn("STALE", text)
            self.assertIn("do not present", text)

    def test_epistemic_law_explicitly_blocks_definition_to_proof_laundering(self):
        s = M.EPISTEMIC_PREFIX
        self.assertIn("definition", s.lower())
        self.assertIn("does not prove", s.lower())
        self.assertIn("external receipt", s.lower())
        self.assertIn("counterexamples", s.lower())


if __name__ == "__main__":
    unittest.main()
