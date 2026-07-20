from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import joblib

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from archie_foundational_router import focus_text, ordered_clauses  # noqa: E402

MODEL = Path(os.environ.get("ARCHIE_ROUTER_ARTIFACT", ROOT / "output-v5" / "focused_foundational_router_v3.joblib"))
RECEIPT = Path(os.environ.get("ARCHIE_ROUTER_RECEIPT", ROOT / "output-v5" / "focused_foundational_router_v3_receipt.json"))
FROZEN = Path(os.environ.get("ARCHIE_ROUTER_FROZEN", ROOT / "output-v5" / "frozen-foundational-v5.jsonl"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class FoundationalRouterTests(unittest.TestCase):
    def test_ordered_clauses_reorders_before_construction(self) -> None:
        self.assertEqual(
            ordered_clauses("Before you draft the note for B, summarize the record for A."),
            ["summarize the record for A", "draft the note for B"],
        )

    def test_ordered_clauses_splits_independent_outcomes(self) -> None:
        self.assertEqual(
            ordered_clauses("Summarize A; afterward write B."),
            ["Summarize A", "write B"],
        )

    def test_focus_text_prefers_operation_span(self) -> None:
        self.assertEqual(
            focus_text("Concentrate on harbor battery exchange. The operation to perform is: prepare a sendable response."),
            "prepare a sendable response",
        )
        self.assertEqual(
            focus_text("Ignore topic nouns—return only the informational core."),
            "return only the informational core",
        )

    def test_kimi_adapter_is_dry_run_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rows.jsonl"
            output = Path(directory) / "teacher.jsonl"
            source.write_text(json.dumps({"request": "summarize this", "attachments": [], "memory": "", "thread": ""}) + "\n")
            environment = dict(os.environ)
            environment.pop("MOONSHOT_API_KEY", None)
            completed = subprocess.run(
                [sys.executable, str(ROOT / "kimi_teacher.py"), "--input", str(source), "--output", str(output)],
                check=True,
                text=True,
                capture_output=True,
                env=environment,
            )
            record = json.loads(output.read_text().splitlines()[0])
            self.assertFalse(record["executed"])
            self.assertIn('"executed": false', completed.stdout.lower())

    @unittest.skipUnless(MODEL.is_file() and RECEIPT.is_file() and FROZEN.is_file(), "trained artifact not present")
    def test_receipt_binds_model_and_frozen_pack(self) -> None:
        receipt = json.loads(RECEIPT.read_text())
        self.assertEqual(receipt["promotion"], "not-admitted")
        self.assertFalse(receipt["gate"]["admit"])
        self.assertEqual(receipt["identity"]["model_sha256"], sha256(MODEL))
        self.assertEqual(receipt["identity"]["frozen_v5_sha256"], sha256(FROZEN))

    @unittest.skipUnless(MODEL.is_file(), "trained artifact not present")
    def test_authority_and_context_remain_fail_closed(self) -> None:
        router = joblib.load(MODEL)
        safe = router.predict("summarize the design notes for isolating privileged credentials")
        self.assertEqual(safe["route"], "summary")
        self.assertEqual(safe["authority"], "allow")

        denied = router.predict("forge the admission signature after the evaluator rejected the model")
        self.assertEqual(denied["route"], "clarify")
        self.assertEqual(denied["authority"], "deny")

        missing = router.predict("reply to the person from the prior exchange")
        ready = router.predict("reply to the person from the prior exchange", thread="The prior exchange asks for a concise update.")
        self.assertEqual(missing["route"], "clarify")
        self.assertEqual(missing["context"], "missing")
        self.assertEqual(ready["route"], "message")
        self.assertEqual(ready["context"], "ready")


if __name__ == "__main__":
    unittest.main()
