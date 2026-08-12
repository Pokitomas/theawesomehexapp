#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("motor_babble.py")
spec = importlib.util.spec_from_file_location("archie_motor_babble", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {MODULE_PATH}")
mb = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mb
spec.loader.exec_module(mb)


class MotorBabbleCourtTests(unittest.TestCase):
    def test_effect_signature_quotients_path_identity(self) -> None:
        left = {
            "created": ["objects/a"],
            "deleted": [],
            "changed": [],
            "created_files": 1,
            "created_dirs": 0,
            "deleted_files": 0,
            "deleted_dirs": 0,
            "changed_files": 0,
            "byte_delta": 7,
        }
        right = {**left, "created": ["elsewhere/completely-different-name"]}
        self.assertEqual(mb.effect_signature(left), mb.effect_signature(right))
        self.assertEqual(mb.digest(mb.effect_signature(left))[:16], mb.digest(mb.effect_signature(right))[:16])

    def test_inverse_and_replay_laws_hold_over_trajectory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="archie-action-test-") as tmp:
            base = Path(tmp)
            world = base / "world"
            ledger = base / "motor.jsonl"
            summary = mb.run_court(world, ledger, steps=256, seed=5601)

            self.assertEqual(summary["inverse_failures"], [])
            self.assertEqual(summary["continuity_failures"], [])
            self.assertEqual(summary["inverse_pass_rate"], 1.0)
            self.assertEqual(summary["continuity_pass_rate"], 1.0)
            self.assertGreaterEqual(summary["latent_code_count"], 2)
            self.assertEqual(summary["ledger_sha256"], mb.file_digest(ledger))

            rows = [json.loads(line) for line in ledger.read_text("utf-8").splitlines() if line.strip()]
            self.assertEqual(len(rows), 256)
            self.assertTrue(all(row["courts"]["inverse_exact"] for row in rows))
            self.assertTrue(all(row["courts"]["replay_exact"] for row in rows))
            self.assertTrue(all(row["schema"] == mb.SCHEMA for row in rows))
            for previous, current in zip(rows, rows[1:]):
                self.assertEqual(previous["state_after_sha256"], current["state_before_sha256"])

    def test_resolve_rejects_sandbox_escape(self) -> None:
        with tempfile.TemporaryDirectory(prefix="archie-action-escape-") as tmp:
            root = Path(tmp) / "world"
            root.mkdir()
            with self.assertRaises(RuntimeError):
                mb.resolve(root, "../outside")


if __name__ == "__main__":
    unittest.main()
