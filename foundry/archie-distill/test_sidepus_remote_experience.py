#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

from sidepus_ephemeral_cache import EphemeralObjectCache
from sidepus_remote_experience import compile_manifest


class RemoteExperienceTest(unittest.TestCase):
    def test_compile_is_zero_download_and_cache_fetches_selected_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = root / "chapter.bin"
            payload.write_bytes(b"ordered remote experience")
            digest = hashlib.sha256(payload.read_bytes()).hexdigest()
            manifest = root / "remote.jsonl"
            inventory = root / "inventory.jsonl"
            source = {
                "schema": "sidepus-remote-experience-record/v1",
                "sequence_id": "book:example",
                "sequence_index": 0,
                "sequence_length": 1,
                "domain": "language_expression",
                "medium": "text",
                "language": "en",
                "quality_score": 0.9,
                "rights": {
                    "approved_by_operator": True,
                    "allow_training": True,
                    "status": "operator-authorized-test",
                },
                "channels": {
                    "observation": [{
                        "sha256": digest,
                        "media_type": "text/plain; charset=utf-8",
                        "bytes": payload.stat().st_size,
                        "fetch": {"url": payload.as_uri()},
                    }]
                },
            }
            manifest.write_text(json.dumps(source) + "\n", encoding="utf-8")
            receipt = compile_manifest(manifest, inventory, allow_file_urls=True)
            self.assertEqual(receipt["records"], 1)
            row = json.loads(inventory.read_text(encoding="utf-8").splitlines()[0])
            item = row["channel_objects"]["observation"][0]
            self.assertEqual(item["sha256"], digest)
            self.assertFalse((root / "state" / "objects").exists())
            with EphemeralObjectCache(
                permanent_state_dir=root / "state",
                cache_dir=root / "cache",
                maximum_bytes=1024,
            ) as cache:
                self.assertEqual(cache.read(item), payload.read_bytes())
                self.assertEqual(cache.snapshot()["cached_objects"], 1)

    def test_credentials_cannot_be_sealed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = b"x"
            digest = hashlib.sha256(payload).hexdigest()
            manifest = root / "remote.jsonl"
            manifest.write_text(json.dumps({
                "schema": "sidepus-remote-experience-record/v1",
                "sequence_id": "tv:test",
                "sequence_index": 0,
                "rights": {"approved_by_operator": True, "allow_training": True},
                "channels": {
                    "observation": [{
                        "sha256": digest,
                        "media_type": "application/octet-stream",
                        "bytes": 1,
                        "fetch": {
                            "url": "https://example.invalid/object",
                            "headers": {"Authorization": "Bearer secret"},
                        },
                    }]
                },
            }) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "credential-bearing"):
                compile_manifest(manifest, root / "inventory.jsonl")


if __name__ == "__main__":
    unittest.main()
