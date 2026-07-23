#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

from archie_hybrid_core import ByteTokenizer
from sidepus_ephemeral_cache import EphemeralObjectCache
from sidepus_experience_compiler import EXPERIENCE_SCHEMA, compile_experience, compile_inventory
from sidepus_pursuit_controller import PursuitController
from sidepus_pursuit_plan import build_intent_plan
from sidepus_pursuit_stream import PursuitExperienceStream


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record(record_id: str, object_sha: str, *, domain: str = "empirical_world") -> dict:
    return {
        "schema": "sidepus-developmental-inventory-record/v1",
        "record_id": record_id,
        "object_sha256": object_sha,
        "bytes": 32,
        "estimated_tokens": 8,
        "domain": domain,
        "medium": "text",
        "language": "en",
        "era": "contemporary",
        "channels": ["observation", "utterance", "production_context"],
        "channel_objects": {
            "observation": [{"sha256": object_sha, "media_type": "text/plain"}],
            "utterance": [{"sha256": object_sha, "media_type": "text/plain"}],
        },
        "rights": {"allow_training": True},
        "quality_score": 0.8,
        "flags": [],
        "source_host": "example.invalid",
    }


class ExperienceCompilerTest(unittest.TestCase):
    def test_uncertain_metadata_is_separate(self) -> None:
        row = record("r1", "0" * 64)
        metadata = compile_experience(row)
        self.assertEqual(metadata["schema"], EXPERIENCE_SCHEMA)
        self.assertTrue(metadata["epistemic_boundary"].startswith("All fields"))
        self.assertEqual(
            metadata["primitive_affordances"]["causal_direction"]["status"],
            "compiler-hypothesis",
        )
        self.assertNotIn("experience_metadata", row)

    def test_compile_inventory_preserves_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "inventory.jsonl"
            output = root / "experience.jsonl"
            row = record("r1", "0" * 64)
            source.write_text(json.dumps(row) + "\n", encoding="utf-8")
            receipt = compile_inventory(source, output)
            compiled = json.loads(output.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(compiled["record_id"], "r1")
            self.assertIn("experience_metadata", compiled)
            self.assertEqual(receipt["counts"]["records"], 1)

    def test_compiler_metadata_is_not_model_visible(self) -> None:
        row = record("r1", "0" * 64, domain="social_institutional")
        row["experience_metadata"] = compile_experience(row)
        stream = object.__new__(PursuitExperienceStream)
        stream._view = lambda item: "SOURCE_PAYLOAD"  # type: ignore[method-assign]
        tokens = stream._render_episode(row)
        rendered = ByteTokenizer.decode(tokens[1:-2])
        self.assertIn("SOURCE_PAYLOAD", rendered)
        self.assertNotIn("affordance_hypotheses", rendered)
        self.assertNotIn("social_institutional", rendered)
        self.assertNotIn("curriculum_vector", rendered)


class CacheTest(unittest.TestCase):
    def test_fetch_verify_and_evict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / "state"
            source_a = root / "a.bin"
            source_b = root / "b.bin"
            source_a.write_bytes(b"a" * 64)
            source_b.write_bytes(b"b" * 64)
            item_a = {"sha256": digest(source_a.read_bytes()), "fetch": {"url": source_a.as_uri()}}
            item_b = {"sha256": digest(source_b.read_bytes()), "fetch": {"url": source_b.as_uri()}}
            with EphemeralObjectCache(
                permanent_state_dir=state,
                cache_dir=root / "cache",
                maximum_bytes=80,
                maximum_object_bytes=128,
            ) as cache:
                self.assertEqual(cache.read(item_a), b"a" * 64)
                self.assertEqual(cache.read(item_b), b"b" * 64)
                snapshot = cache.snapshot()
                self.assertLessEqual(snapshot["cached_bytes"], 80)
                self.assertEqual(snapshot["cached_objects"], 1)


class PursuitTest(unittest.TestCase):
    def test_controller_moves_toward_progress_and_state_utility(self) -> None:
        controller = PursuitController(seed=7)
        rows = [
            {"intent_id": "a", "record_id": "a", "primary_domain": "x", "difficulty_prior": 0.2},
            {"intent_id": "b", "record_id": "b", "primary_domain": "y", "difficulty_prior": 0.2},
        ]
        controller.feedback([rows[1]], loss=2.0, state_utility=0.3, deliberation=2.0)
        controller.feedback([rows[1]], loss=1.0, state_utility=0.4, deliberation=2.0)
        self.assertEqual(controller.choose(rows, 1), [1])
        restored = PursuitController(seed=7)
        restored.load_state_dict(controller.state_dict())
        self.assertEqual(restored.choose(rows, 1), [1])

    def test_intent_plan_does_not_require_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            inventory = root / "inventory.jsonl"
            output = root / "plan.jsonl"
            rows = []
            for index in range(3):
                row = record(f"r{index}", f"{index:064x}")
                row["experience_metadata"] = compile_experience(row)
                rows.append(row)
            inventory.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )
            receipt = build_intent_plan(
                inventory=inventory,
                output=output,
                samples=5,
                sequence_length=64,
                seed=9,
                minimum_quality=0.1,
                required_channels=["utterance"],
                excluded_flags=["rights-blocked"],
                domain_targets=None,
            )
            self.assertEqual(receipt["samples"], 5)
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 5)
            self.assertTrue(receipt["two_phase_sealing"])


if __name__ == "__main__":
    unittest.main()
