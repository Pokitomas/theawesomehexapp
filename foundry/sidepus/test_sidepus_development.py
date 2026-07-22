from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

from .catalog import digest_json
from .development import (
    INVENTORY_SCHEMA,
    compile_program,
    validate_program,
    verify_compilation,
)


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
POLICY = REPOSITORY_ROOT / "foundry" / "sidepus" / "plans" / "content-policy-broad-v2.json"
PROGRAM = REPOSITORY_ROOT / "foundry" / "sidepus" / "plans" / "developmental-program-v1.json"
DOMAINS = (
    "language_expression",
    "empirical_world",
    "formal_executable",
    "social_institutional",
    "multimodal_episode",
    "adversarial_messy",
)
CHANNELS = (
    "observation",
    "production_context",
    "utterance",
    "interpretation",
    "action_consequence",
    "evaluation_only",
)


class SidepusDevelopmentTest(unittest.TestCase):
    def write_inventory(self, path: pathlib.Path) -> None:
        with path.open("w", encoding="utf-8") as handle:
            for domain_index, domain in enumerate(DOMAINS):
                for ordinal in range(4):
                    record_id = f"{domain}-{ordinal}"
                    record = {
                        "schema": INVENTORY_SCHEMA,
                        "record_id": record_id,
                        "object_sha256": hashlib.sha256(record_id.encode()).hexdigest(),
                        "bytes": 4096 + ordinal,
                        "estimated_tokens": 1000 + (domain_index * 10) + ordinal,
                        "domain": domain,
                        "medium": "video" if domain == "multimodal_episode" else "document",
                        "language": "es" if ordinal == 0 else "en",
                        "era": "2020_2026",
                        "channels": list(CHANNELS),
                        "rights": "test-fixture",
                        "quality_score": 0.20 if domain == "adversarial_messy" else 0.80,
                        "flags": ["deliberate-contamination"] if domain == "adversarial_messy" else [],
                    }
                    handle.write(json.dumps(record, sort_keys=True) + "\n")

    def test_repository_program_is_bound_to_repository_policy(self) -> None:
        program = json.loads(PROGRAM.read_text(encoding="utf-8"))
        policy = json.loads(POLICY.read_text(encoding="utf-8"))
        validation = validate_program(program)
        self.assertEqual(program["acquisition_policy_digest"], digest_json(policy))
        self.assertEqual(len(validation["lineage_ids"]), 4)

    def test_compile_separates_hidden_supervision_and_controls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            inventory = root / "inventory.jsonl"
            output = root / "compiled"
            self.write_inventory(inventory)
            receipt = compile_program(
                program_path=PROGRAM,
                content_policy_path=POLICY,
                inventory_paths=[inventory],
                output_dir=output,
            )
            self.assertTrue(receipt["schedule"]["guardrail_passed"])
            self.assertGreater(receipt["schedule"]["rows"], 100)
            rows = [json.loads(line) for line in
                (output / "developmental-schedule.jsonl").read_text(encoding="utf-8").splitlines()]
            experimental = next(row for row in rows
                if row["lineage"] == "episode_state_experimental"
                and row["stage"] == "grounded_interleave")
            flattened = next(row for row in rows
                if row["lineage"] == "flattened_assistant_control"
                and row["stage"] == "grounded_interleave")
            self.assertIn("interpretation", experimental["hidden_targets"])
            self.assertNotIn("interpretation", experimental["visible_channels"])
            self.assertIn("interpretation", flattened["visible_channels"])
            self.assertNotIn("interpretation", flattened["hidden_targets"])
            self.assertTrue(verify_compilation(output / "developmental-receipt.json")["passed"])

    def test_policy_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            inventory = root / "inventory.jsonl"
            self.write_inventory(inventory)
            policy = json.loads(POLICY.read_text(encoding="utf-8"))
            policy["maximum_archive_bytes"] += 1
            changed = root / "changed-policy.json"
            changed.write_text(json.dumps(policy), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not bound"):
                compile_program(
                    program_path=PROGRAM,
                    content_policy_path=changed,
                    inventory_paths=[inventory],
                    output_dir=root / "compiled",
                )

    def test_tampered_schedule_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            inventory = root / "inventory.jsonl"
            output = root / "compiled"
            self.write_inventory(inventory)
            compile_program(
                program_path=PROGRAM,
                content_policy_path=POLICY,
                inventory_paths=[inventory],
                output_dir=output,
            )
            schedule = output / "developmental-schedule.jsonl"
            schedule.write_text(schedule.read_text(encoding="utf-8") + "{}\n", encoding="utf-8")
            verification = verify_compilation(output / "developmental-receipt.json")
            self.assertFalse(verification["passed"])
            self.assertFalse(verification["checks"]["schedule_file"])


if __name__ == "__main__":
    unittest.main()
