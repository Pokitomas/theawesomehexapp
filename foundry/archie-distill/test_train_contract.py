#!/usr/bin/env python3
"""Dependency-free contract tests for the Archie neural trainer."""
from __future__ import annotations

import ast
import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("train.py")


def load_module():
    spec = importlib.util.spec_from_file_location("archie_neural_train", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class NeuralTrainerContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = MODULE_PATH.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)
        cls.module = load_module()

    def test_trainer_is_valid_python_without_ml_dependencies(self):
        compile(self.source, str(MODULE_PATH), "exec")

    def test_negative_rows_become_explicit_corrections(self):
        target = json.loads(self.module.correction_target({"reason": "authority denied"}))
        self.assertEqual(target["decision"], "reject-and-replan")
        self.assertEqual(target["reason"], "authority denied")
        self.assertIn("Do not repeat", target["required_behavior"])

    def test_jsonl_reader_rejects_non_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "rows.jsonl"
            path.write_text("[]\n", encoding="utf-8")
            with self.assertRaises(SystemExit):
                self.module.read_jsonl(path)

    def test_receipt_remains_fail_closed(self):
        self.assertIn('"promotion": "not-admitted"', self.source)
        self.assertIn('archie-neural-training-receipt/v2', self.source)

    def test_all_compiled_dataset_lanes_are_consumed(self):
        for filename in (
            "pretrain.train.jsonl",
            "sft.train.jsonl",
            "negative.train.jsonl",
            "development-holdout.jsonl",
        ):
            self.assertIn(filename, self.source)

    def test_no_network_model_loading(self):
        self.assertGreaterEqual(self.source.count("local_files_only=True"), 2)
        self.assertNotIn("from_pretrained(profile[", self.source)


if __name__ == "__main__":
    unittest.main()
