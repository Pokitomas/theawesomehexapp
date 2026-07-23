#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

import numpy as np

from archie_fixed_eval import MANIFEST_SCHEMA, stable_json, validate_manifest


class FixedEvaluationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.corpus = self.root / "fixture.u16"
        values = np.asarray([257, *b"abcdefghijklmno", 258, 259], dtype="<u2")
        self.corpus.write_bytes(values.tobytes())
        digest = hashlib.sha256(self.corpus.read_bytes()).hexdigest()
        self.metadata = {
            "schema": "archie-u16-byte-corpus/v1",
            "dtype": "<u2",
            "token_count": len(values),
            "sha256": digest,
        }
        self.corpus.with_suffix(".u16.json").write_text(json.dumps(self.metadata), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def manifest(self, **changes: object) -> pathlib.Path:
        value = {
            "schema": MANIFEST_SCHEMA,
            "sealed": True,
            "domain": "general-prose",
            "corpus_sha256": self.metadata["sha256"],
            "corpus_token_count": self.metadata["token_count"],
            "windows": [
                {"source_id": "fixture-a", "offset": 0, "length": 8, "split": "eval"},
                {"source_id": "fixture-b", "offset": 8, "length": 8, "split": "eval"},
            ],
            "selection": "unit-test",
            "promotion": "research-only-not-admitted",
        }
        value.update(changes)
        value["manifest_digest"] = hashlib.sha256(stable_json(value).encode()).hexdigest()
        path = self.root / "manifest.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_accepts_exact_sealed_windows(self) -> None:
        result = validate_manifest(self.manifest(), self.corpus)
        self.assertEqual(result["domain"], "general-prose")
        self.assertEqual(len(result["windows"]), 2)

    def test_rejects_unsealed_blocker(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsealed"):
            validate_manifest(self.manifest(sealed=False), self.corpus)

    def test_rejects_corpus_tamper(self) -> None:
        path = self.manifest()
        self.corpus.write_bytes(self.corpus.read_bytes() + b"\x00\x00")
        with self.assertRaises(ValueError):
            validate_manifest(path, self.corpus)

    def test_rejects_overlapping_windows(self) -> None:
        windows = [
            {"source_id": "a", "offset": 0, "length": 10, "split": "eval"},
            {"source_id": "b", "offset": 9, "length": 4, "split": "eval"},
        ]
        with self.assertRaisesRegex(ValueError, "overlapping"):
            validate_manifest(self.manifest(windows=windows), self.corpus)

    def test_rejects_manifest_digest_drift(self) -> None:
        path = self.manifest()
        value = json.loads(path.read_text())
        value["windows"][0]["source_id"] = "tampered"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "digest"):
            validate_manifest(path, self.corpus)


if __name__ == "__main__":
    unittest.main()
