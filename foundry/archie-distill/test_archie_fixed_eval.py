#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

import numpy as np
import torch

from archie_baseline_identity import SOURCE_CORE_BLOB, git_blob_sha1, sha256_file
from archie_fixed_eval import (
    INPUT_RECEIPT_SCHEMA,
    MANIFEST_SCHEMA,
    attest_inputs,
    corpus_metadata,
    stable_json,
    validate_manifest,
)
from archie_hybrid_core import ArchieHybridLM, ByteTokenizer, ModelConfig
from archie_hybrid_corpus import build_u16_corpus


class FixedEvaluationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.corpus = self.root / "fixture.u16"
        self.metadata = build_u16_corpus(
            self.corpus,
            [("fixture-a", "abcdefgh"), ("fixture-b", "ijklmnop")],
            max_tokens=None,
            tokenizer=ByteTokenizer(),
        )

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

    def test_accepts_real_v2_corpus_contract(self) -> None:
        metadata = corpus_metadata(self.corpus)
        self.assertEqual(metadata["schema"], "archie-u16-token-corpus/v2")
        self.assertEqual(metadata["tokenizer"]["schema"], "archie-byte-tokenizer/v1")
        result = validate_manifest(self.manifest(), self.corpus)
        self.assertEqual(result["domain"], "general-prose")

    def test_exact_source_core_is_the_bound_git_blob(self) -> None:
        core = pathlib.Path(__file__).with_name("archie_hybrid_core.py")
        self.assertEqual(git_blob_sha1(core), SOURCE_CORE_BLOB)

    def test_tiny_v2_corpus_and_exact_source_export_attest_end_to_end(self) -> None:
        cfg = ModelConfig(
            d_model=32,
            n_layers=2,
            n_heads=4,
            n_kv_heads=2,
            d_ff=64,
            ssm_expand=2,
            ssm_chunk_size=7,
            conv_kernel=3,
            attention_every=2,
            attention_window=16,
            mixer_mode="hybrid",
            plastic_mode="none",
            max_seq_len=64,
        )
        model = ArchieHybridLM(cfg)
        export = self.root / "tiny.pt"
        torch.save({
            "schema": "archie-scratch-hybrid-model/v1",
            "config": cfg.__dict__,
            "model": model.state_dict(),
        }, export)
        output = self.root / "input-receipt.json"
        receipt = attest_inputs(
            export,
            self.corpus,
            output,
            "cpu",
            expected_model_sha256=sha256_file(export),
        )
        self.assertEqual(receipt["schema"], INPUT_RECEIPT_SCHEMA)
        self.assertEqual(receipt["model"]["source_core_blob"], SOURCE_CORE_BLOB)
        self.assertEqual(receipt["corpus"]["schema"], "archie-u16-token-corpus/v2")
        self.assertEqual(json.loads(output.read_text())["receipt_digest"], receipt["receipt_digest"])

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
