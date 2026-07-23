from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from .catalog import Catalog
from .extraction import RIGHTS_SCHEMA, export_developmental_inventory, verify_inventory
from .warc import validate_warc, write_replay_warc


ROOT = pathlib.Path(__file__).resolve().parents[2]
POLICY = ROOT / "foundry" / "sidepus" / "plans" / "content-policy-broad-v2.json"


class SidepusExtractionTest(unittest.TestCase):
    def build_state(self, root: pathlib.Path) -> pathlib.Path:
        state = root / "state"
        body = root / "body.html"
        body.write_text(
            "<html><head><script>SECRET_SHORTCUT</script></head>"
            "<body><h1>Research experiment</h1><p>Alice measured the physical system. "
            "The result contradicted the original hypothesis.</p></body></html>",
            encoding="utf-8",
        )
        warc = root / "fixture.warc.gz"
        write_replay_warc(
            warc,
            target_uri="https://example.com/research/experiment.html",
            capture_timestamp="20260722120000",
            status=200,
            reason="OK",
            response_headers={"Content-Type": "text/html; charset=utf-8"},
            body_path=body,
            source_uri="https://fixture.invalid/source",
        )
        with Catalog(state) as catalog:
            catalog.install_policy("content", json.loads(POLICY.read_text(encoding="utf-8")))
            digest, _, stored = catalog.import_object(warc, media_type="application/warc", move=False)
            validation = validate_warc(stored)
            catalog.register_warc_records(digest, validation["records"], {
                "adapter": "test-fixture",
                "locator": {"languages": "eng"},
            })
        return state

    def test_extracts_separate_channel_objects(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            state = self.build_state(root)
            rights = root / "rights.json"
            rights.write_text(json.dumps({
                "schema": RIGHTS_SCHEMA,
                "approved_by_operator": True,
                "rules": [{
                    "host_suffix": "example.com",
                    "status": "licensed-test-fixture",
                    "label": "fixture",
                    "allow_training": True,
                }],
            }), encoding="utf-8")
            inventory = root / "inventory.jsonl"
            receipt = export_developmental_inventory(
                state_dir=state,
                output=inventory,
                rights_manifest=rights,
                maximum_records=10,
            )
            self.assertEqual(receipt["counts"]["selected"], 1)
            record = json.loads(inventory.read_text(encoding="utf-8").strip())
            self.assertEqual(record["language"], "en")
            self.assertEqual(record["domain"], "empirical_world")
            self.assertEqual(
                set(record["channels"]),
                {"observation", "production_context", "utterance", "interpretation"},
            )
            self.assertNotIn("rights-blocked", record["flags"])
            with Catalog(state) as catalog:
                utterance = catalog.object_path(
                    record["channel_objects"]["utterance"][0]["sha256"]
                ).read_text(encoding="utf-8")
            self.assertIn("Alice measured", utterance)
            self.assertNotIn("SECRET_SHORTCUT", utterance)
            self.assertTrue(verify_inventory(inventory.with_suffix(".jsonl.receipt.json"))["passed"])

    def test_unknown_rights_fail_closed_for_training(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            state = self.build_state(root)
            inventory = root / "inventory.jsonl"
            export_developmental_inventory(state_dir=state, output=inventory, maximum_records=10)
            record = json.loads(inventory.read_text(encoding="utf-8").strip())
            self.assertIn("rights-blocked", record["flags"])
            self.assertFalse(record["rights"]["allow_training"])


if __name__ == "__main__":
    unittest.main()
