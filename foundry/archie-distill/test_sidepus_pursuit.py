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
from sidepus_inventory_union import union
from sidepus_microphysics import generate
from sidepus_pursuit_controller import PursuitController
from sidepus_pursuit_plan import MODEL_VISIBLE_CHANNELS, build_intent_plan
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

    def test_compiler_and_hidden_truth_are_not_model_visible(self) -> None:
        row = record("r1", "0" * 64, domain="social_institutional")
        row["experience_metadata"] = compile_experience(row)
        row["channels"].append("interpretation")
        row["channel_objects"]["interpretation"] = [
            {"sha256": "1" * 64, "media_type": "text/plain"}
        ]
        stream = object.__new__(PursuitExperienceStream)

        def item_tokens(item: dict) -> list[int]:
            marker = "HIDDEN_TRUTH" if item["sha256"] == "1" * 64 else "SOURCE_PAYLOAD"
            return ByteTokenizer.encode(marker)

        stream._item_tokens = item_tokens  # type: ignore[method-assign]
        tokens = stream._render_episode(row)
        rendered = ByteTokenizer.decode(tokens)
        self.assertIn("SOURCE_PAYLOAD", rendered)
        self.assertNotIn("HIDDEN_TRUTH", rendered)
        self.assertNotIn("social_institutional", rendered)
        self.assertNotIn("curriculum_vector", rendered)
        self.assertNotIn("interpretation", MODEL_VISIBLE_CHANNELS)

    def test_raw_sensory_bytes_survive_without_text_conversion(self) -> None:
        class Cache:
            @staticmethod
            def read(item: dict) -> bytes:
                return bytes((0, 1, 127, 128, 254, 255))

        stream = object.__new__(PursuitExperienceStream)
        stream.cache = Cache()
        tokens = stream._item_tokens({
            "sha256": "0" * 64,
            "media_type": "application/x-sidepus-raster-u8",
            "representation": "raster-time-u8",
        })
        self.assertEqual(tokens, [0, 1, 127, 128, 254, 255])


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


class MicrophysicsTest(unittest.TestCase):
    def test_generator_separates_raw_sensation_from_hidden_truth(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / "state"
            inventory = root / "micro.jsonl"
            receipt = generate(
                state_dir=state,
                output=inventory,
                episodes=2,
                seed=11,
                size=8,
                body_count=2,
                frames=4,
                frames_per_record=2,
            )
            rows = [json.loads(line) for line in inventory.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(receipt["records"], 4)
            self.assertEqual(len({row["sequence_id"] for row in rows}), 2)
            first = rows[0]
            observation = first["channel_objects"]["observation"][0]
            self.assertEqual(observation["representation"], "raster-time-u8")
            self.assertIn("interpretation", first["channel_objects"])
            path = state / "objects" / "sha256" / observation["sha256"][:2] / observation["sha256"][2:]
            self.assertTrue(path.is_file())
            self.assertEqual(path.stat().st_size, 2 * 8 * 8)

    def test_inventory_union_copies_no_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            first = root / "a.jsonl"
            second = root / "b.jsonl"
            output = root / "union.jsonl"
            first.write_text(json.dumps(record("a", "0" * 64)) + "\n", encoding="utf-8")
            second.write_text(json.dumps(record("b", "1" * 64)) + "\n", encoding="utf-8")
            receipt = union([first, second], output)
            self.assertEqual(receipt["records"], 2)
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 2)


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

    def test_controller_prefers_next_useful_episode_state(self) -> None:
        controller = PursuitController(seed=19)
        previous = {
            "intent_id": "p0", "record_id": "p0", "primary_domain": "multimodal_episode",
            "state_thread_id": "episode", "sequence_index": 0, "difficulty_prior": 0.4,
        }
        controller.feedback([previous], loss=1.5, state_utility=0.4, deliberation=2.0)
        candidates = [
            {
                "intent_id": "p1", "record_id": "p1", "primary_domain": "multimodal_episode",
                "state_thread_id": "episode", "sequence_index": 1, "difficulty_prior": 0.4,
            },
            {
                "intent_id": "q", "record_id": "q", "primary_domain": "multimodal_episode",
                "state_thread_id": "other", "sequence_index": 0, "difficulty_prior": 0.4,
            },
        ]
        self.assertEqual(controller.choose(candidates, 1), [0])

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
                required_channels=["observation"],
                excluded_flags=["rights-blocked"],
                domain_targets=None,
            )
            plan_rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(receipt["samples"], 5)
            self.assertEqual(len(plan_rows), 5)
            self.assertTrue(receipt["two_phase_sealing"])
            self.assertTrue(all(row["state_thread_id"] == row["intent_id"] for row in plan_rows))

    def test_intent_plan_preserves_explicit_sequence_runs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / "state"
            inventory = root / "micro.jsonl"
            output = root / "plan.jsonl"
            generate(
                state_dir=state,
                output=inventory,
                episodes=1,
                seed=3,
                size=8,
                body_count=2,
                frames=8,
                frames_per_record=2,
            )
            receipt = build_intent_plan(
                inventory=inventory,
                output=output,
                samples=12,
                sequence_length=64,
                seed=3,
                minimum_quality=0.1,
                required_channels=["observation"],
                excluded_flags=["rights-blocked"],
                domain_targets={"multimodal_episode": 1.0},
                sequence_follow_probability=1.0,
            )
            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertGreater(receipt["realized_sequence_follows"], 0)
            self.assertTrue(all(row["has_explicit_sequence"] for row in rows))
            self.assertTrue(all(row["state_thread_id"].startswith("microphysics:") for row in rows))
            self.assertIn("interpretation", receipt["hidden_archive_channels"])


if __name__ == "__main__":
    unittest.main()
