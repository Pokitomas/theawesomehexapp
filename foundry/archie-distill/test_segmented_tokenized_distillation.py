#!/usr/bin/env python3
"""Dependency-light contracts for recursive segmented tokenized distillation."""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# Keep this contract suite dependency-light. The imported modules use these helpers only
# inside their executable paths; the unit contracts below exercise pure functions/source.
train_stub = types.ModuleType("train")
for name in (
    "artifact_manifest",
    "directory_identity",
    "package_versions",
    "read_json",
    "read_jsonl",
    "require_profile",
    "sha256",
    "stable",
    "tokenizer_identity",
):
    setattr(train_stub, name, lambda *args, **kwargs: None)
sys.modules.setdefault("train", train_stub)

causal_stub = types.ModuleType("train_causal_divergence")
causal_stub.CausalDivergenceCollator = object
causal_stub.sequence_log_prob = lambda *args, **kwargs: None
causal_stub.tokenize_pair = lambda *args, **kwargs: None
sys.modules.setdefault("train_causal_divergence", causal_stub)


def load(name: str):
    path = ROOT / name
    spec = importlib.util.spec_from_file_location(name.replace(".", "_"), path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


segment = load("segment_causal_pairs.py")
decide = load("decide_recursive_round.py")
evaluate_fused = load("evaluate_fused_adapter.py")


class TinyTokenizer:
    eos_token_id = 99
    pad_token_id = 0
    vocab_size = 128
    chat_template = None

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [ord(character) % 127 for character in text]}


def pair(index: int, *, group: str | None = None, chosen: str = "abcXgood", rejected: str = "abcYbad"):
    body = {
        "schema": segment.PAIR_SCHEMA,
        "pair_id": f"pair-{index}",
        "group_id": group or f"group-{index}",
        "instruction": f"repair task {index}",
        "compact_context": {"repository": "x/y"},
        "chosen_target": chosen + ("!" * index),
        "rejected_target": rejected,
        "evidence_weight": 1 + index / 10,
    }
    return {**body, "pair_digest": segment.digest(body)}


class SegmentedTokenizedDistillationTest(unittest.TestCase):
    def test_token_balancing_is_deterministic_and_lineage_atomic(self):
        rows = [pair(1, group="shared"), pair(2, group="shared"), pair(3), pair(4)]
        development = [pair(20), pair(21)]
        first = segment.build_shards(rows, development, TinyTokenizer(), shard_count=3, seed=3407, round_number=0)
        second = segment.build_shards(rows, development, TinyTokenizer(), shard_count=3, seed=3407, round_number=0)
        self.assertEqual(
            [[item["pair_ids"], item["raw_token_cost"]] for item in first["shards"]],
            [[item["pair_ids"], item["raw_token_cost"]] for item in second["shards"]],
        )
        assignment = {pair_id: item["index"] for item in first["shards"] for pair_id in item["pair_ids"]}
        self.assertEqual(assignment["pair-1"], assignment["pair-2"])
        self.assertTrue(all(len(item["development_rows"]) == len(development) for item in first["shards"]))

    def test_quantization_failure_priority_enters_the_next_round(self):
        rows = [pair(1), pair(2), pair(3), pair(4)]
        development = [pair(20)]
        result = segment.build_shards(
            rows,
            development,
            TinyTokenizer(),
            shard_count=2,
            seed=3407,
            round_number=1,
            quant_priorities={"pair-3": 4.0},
        )
        self.assertIn("pair-3", result["shards"][0]["quant_priority_pairs"])
        self.assertGreater(result["shards"][0]["weighted_token_cost"], result["shards"][0]["raw_token_cost"])

    def test_recursion_requires_concrete_adapter_or_quantized_failure(self):
        severity, reasons = decide.case_severity(
            {
                "base": {"passed": False, "score": 0.2},
                "adapter": {"passed": True, "score": 0.8},
                "quantized": {"Q4_K_M": {"passed": False, "quality_retention": 0.7}},
            },
            quant_floor=0.97,
        )
        self.assertEqual(severity, 4.0)
        self.assertIn("Q4_K_M-lost-adapter-success", reasons)
        clean, clean_reasons = decide.case_severity(
            {
                "base": {"passed": False, "score": 0.2},
                "adapter": {"passed": True, "score": 0.8},
                "quantized": {"Q4_K_M": {"passed": True, "quality_retention": 0.99}},
            },
            quant_floor=0.97,
        )
        self.assertEqual(clean, 0.0)
        self.assertEqual(clean_reasons, [])

    def test_fused_gate_requires_a_strict_measured_gain(self):
        self.assertFalse(evaluate_fused.strict_gain({
            "pair_accuracy_delta": 0.0,
            "mean_pair_margin_delta": 0.0,
            "chosen_negative_log_probability_delta": 0.0,
        }))
        self.assertTrue(evaluate_fused.strict_gain({
            "pair_accuracy_delta": 0.0,
            "mean_pair_margin_delta": 0.01,
            "chosen_negative_log_probability_delta": 0.0,
        }))

    def test_verifier_requires_changed_tensors_and_frozen_base_comparison(self):
        source = (ROOT / "verify_segment_adapter.py").read_text(encoding="utf-8")
        for marker in (
            "No LoRA adapter tensor changed",
            "get_peft_model_state_dict",
            "load_peft_weights",
            "model.disable_adapter()",
            '"changed_tensor_count"',
            '"pair_accuracy_delta"',
            '"promotion": "not-admitted"',
            "Refusing CPU fallback",
        ):
            self.assertIn(marker, source)

    def test_fused_evaluator_blocks_quantization_without_non_regressive_gain(self):
        source = (ROOT / "evaluate_fused_adapter.py").read_text(encoding="utf-8")
        for marker in (
            "capability_gain_observed",
            "quantization_eligible",
            "adapter_enabled=False",
            "strict non-regressive held-out improvement",
            '"promotion": "not-admitted"',
            "Refusing CPU fallback",
        ):
            self.assertIn(marker, source)

    def test_fuser_combines_deltas_not_factors(self):
        source = (ROOT / "fuse_segment_adapters.py").read_text(encoding="utf-8")
        for marker in (
            "average(B) @",
            "torch.cat(a_parts, dim=0)",
            "torch.cat(b_parts, dim=1)",
            "exact-rank-concatenation",
            "truncated-svd",
            "not a claim of globally unique prior art",
        ):
            self.assertIn(marker, source)


if __name__ == "__main__":
    unittest.main()
