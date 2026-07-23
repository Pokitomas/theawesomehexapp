#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

import torch

from sidepus_training_stream import PlanBatchSampler, build_plan, sha256_file


class SidepusDirectStreamTests(unittest.TestCase):
    def object(self, root: pathlib.Path, payload: bytes) -> tuple[str, pathlib.Path]:
        digest = hashlib.sha256(payload).hexdigest()
        path = root / "objects" / "sha256" / digest[:2] / digest[2:]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return digest, path

    def test_plan_is_replayable_and_tamper_evident(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            inventory = root / "inventory.jsonl"
            rows = []
            for index, domain in enumerate(("language_expression", "empirical_world", "formal_executable")):
                utterance = (f"record {index} in {domain} preserves direct archive replay\n" * 80).encode()
                context = json.dumps({"index": index, "domain": domain}).encode()
                utterance_sha, _ = self.object(root, utterance)
                context_sha, _ = self.object(root, context)
                rows.append({
                    "schema": "sidepus-developmental-inventory-record/v1",
                    "record_id": f"record-{index}",
                    "object_sha256": utterance_sha,
                    "bytes": len(utterance),
                    "estimated_tokens": len(utterance),
                    "domain": domain,
                    "medium": "text",
                    "language": "en",
                    "era": "2020_2026",
                    "channels": ["production_context", "utterance"],
                    "channel_objects": {
                        "production_context": [{
                            "sha256": context_sha,
                            "media_type": "application/json",
                            "bytes": len(context),
                        }],
                        "utterance": [{
                            "sha256": utterance_sha,
                            "media_type": "text/plain; charset=utf-8",
                            "bytes": len(utterance),
                        }],
                    },
                    "rights": {"allow_training": True, "status": "approved"},
                    "quality_score": 0.9,
                    "flags": [],
                    "source_host": "example.test",
                })
            inventory.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            plan = root / "plan.jsonl"
            receipt = build_plan(
                state_dir=root,
                inventory=inventory,
                output=plan,
                samples=8,
                sequence_length=64,
                seed=7,
                render_mode="multichannel",
                minimum_quality=0.3,
                required_channels=["utterance"],
                excluded_flags=["rights-blocked"],
                domain_targets=None,
            )
            self.assertEqual(receipt["samples"], 8)
            receipt_path = plan.with_suffix(plan.suffix + ".receipt.json")
            with PlanBatchSampler(
                plan,
                receipt_path,
                batch_size=2,
                sequence_length=64,
                workers=2,
            ) as sampler:
                first, rows_first = sampler.batch_with_rows(torch.device("cpu"))
                saved = sampler.state_dict()
                second = sampler.batch(torch.device("cpu"))
                self.assertEqual(tuple(first.shape), (2, 65))
                self.assertEqual(tuple(second.shape), (2, 65))
                self.assertEqual(len(rows_first), 2)
                sampler.load_state_dict(saved)
                replay = sampler.batch(torch.device("cpu"))
                self.assertTrue(torch.equal(second, replay))
            original = sha256_file(plan)
            plan.write_text(plan.read_text() + "{}\n", encoding="utf-8")
            self.assertNotEqual(original, sha256_file(plan))
            with self.assertRaises(ValueError):
                PlanBatchSampler(
                    plan,
                    receipt_path,
                    batch_size=1,
                    sequence_length=64,
                )


if __name__ == "__main__":
    unittest.main()
