#!/usr/bin/env python3
"""Dependency-free contract tests for the Archie neural trainer."""
from __future__ import annotations

import ast
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("train.py")
ROOT = MODULE_PATH.parent


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
        for variable in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
            self.assertIn(f'os.environ["{variable}"] = "1"', self.source)
        self.assertNotIn("from_pretrained(profile[", self.source)

    def test_cuda_only_nf4_qlora_has_no_cpu_fallback(self):
        self.assertIn("if not torch.cuda.is_available():", self.source)
        self.assertIn("Refusing slow full-precision CPU training", self.source)
        self.assertNotIn("return torch.float32", self.source)
        for marker in (
            "load_in_4bit=True",
            'bnb_4bit_quant_type="nf4"',
            "bnb_4bit_use_double_quant=True",
            "bnb_4bit_compute_dtype=compute_dtype",
            "prepare_model_for_kbit_training",
            "is_loaded_in_4bit",
            "non_adapter_parameters",
        ):
            self.assertIn(marker, self.source)

    def test_training_is_deterministic_and_memory_bounded(self):
        for marker in (
            "CUBLAS_WORKSPACE_CONFIG",
            "torch.use_deterministic_algorithms(True)",
            "allow_tf32 = False",
            '"dataloader_num_workers": 0',
            '"optim": "paged_adamw_8bit"',
            '"gradient_checkpointing": True',
            '"packing": bool(cfg.get("packing", True))',
            "default=1024",
        ):
            self.assertIn(marker, self.source)

    def test_receipt_binds_exact_neural_inputs_and_runtime(self):
        for marker in (
            "checkpoint_identity",
            "checkpoint_tokenizer_identity",
            "dataset_identity(dataset_paths)",
            "training_order_digest",
            "package_versions",
            "torch.cuda.get_device_name",
            "quantization_values",
            "artifact_manifest(adapter_dir)",
        ):
            self.assertIn(marker, self.source)


def load_tests(loader, standard_tests, pattern):
    """Attach repository-new neural-objective and CUDA bridge suites to the canonical gate."""
    suite = unittest.TestSuite()
    suite.addTests(standard_tests)
    for filename in (
        "test_causal_divergence_contract.py",
        "test_compile_causal_pairs.py",
        "test_causal_divergence_gradient.py",
        "test_causal_divergence_loss_math.py",
        "test_cuda_causal_workflow_contract.py",
    ):
        path = ROOT / filename
        spec = importlib.util.spec_from_file_location(f"archie_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        suite.addTests(loader.loadTestsFromModule(module))
    return suite


if __name__ == "__main__":
    unittest.main()
