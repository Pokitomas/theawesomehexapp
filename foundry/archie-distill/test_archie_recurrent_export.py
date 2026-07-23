#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import tempfile
import unittest

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig
from archie_recurrent_export import load_recurrent_export, normalize_baseline_config, sha256_file


class RecurrentExportTests(unittest.TestCase):
    def raw_config(self) -> dict:
        return {
            "vocab_size": 260,
            "d_model": 32,
            "n_layers": 2,
            "n_heads": 4,
            "n_kv_heads": 2,
            "d_ff": 64,
            "ssm_expand": 2,
            "ssm_chunk_size": 128,
            "conv_kernel": 3,
            "attention_every": 2,
            "attention_window": 16,
            "mixer_mode": "hybrid",
            "plastic_mode": "none",
            "plastic_rank": 16,
            "plastic_retention_floor": 0.95,
            "plastic_write_scale": 0.25,
            "plastic_state_clip": 4.0,
            "plastic_detach_every": 128,
            "dropout": 0.0,
            "max_seq_len": 64,
            "rope_base": 10000.0
        }

    def test_normalizes_exact_source_only_fields(self) -> None:
        cfg, source_only = normalize_baseline_config(self.raw_config())
        self.assertEqual(cfg.d_model, 32)
        self.assertEqual(source_only["ssm_chunk_size"], 128)
        self.assertEqual(source_only["plastic_mode"], "none")

    def test_rejects_wrong_lineage_modes(self) -> None:
        raw = self.raw_config()
        raw["plastic_mode"] = "delta"
        with self.assertRaisesRegex(ValueError, "must not contain plastic"):
            normalize_baseline_config(raw)
        raw = self.raw_config()
        raw["mixer_mode"] = "attention"
        with self.assertRaisesRegex(ValueError, "must use hybrid"):
            normalize_baseline_config(raw)

    def test_loads_strict_state_dict_and_binds_digest(self) -> None:
        raw = self.raw_config()
        cfg, _ = normalize_baseline_config(raw)
        baseline = ArchieHybridLM(cfg)
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "model.pt"
            torch.save({"schema": "archie-scratch-hybrid-model/v1", "config": raw, "model": baseline.state_dict()}, path)
            digest = sha256_file(path)
            recurrent, identity = load_recurrent_export(path, expected_sha256=digest)
            self.assertEqual(identity["export_sha256"], digest)
            self.assertEqual(identity["parameters"], sum(p.numel() for p in recurrent.parameters()))
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                load_recurrent_export(path, expected_sha256="0" * 64)


if __name__ == "__main__":
    unittest.main()
