#!/usr/bin/env python3
"""Dependency-light tests for Archie causal-divergence neural training."""
from __future__ import annotations
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def load(name: str):
    path = ROOT / name
    spec = importlib.util.spec_from_file_location(name.replace(".", "_"), path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


compiler = load("compile_causal_pairs.py")
trainer = load("train_causal_divergence.py")


class TinyTokenizer:
    eos_token_id = 99
    pad_token_id = 0
    chat_template = None

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [ord(character) % 89 + 1 for character in text]}


class CausalDivergenceContractTest(unittest.TestCase):
    def row(self, pair_id, group_id, chosen="abcXgood-tail", rejected="abcYbad-tail", evidence=2):
        return {
            "schema": trainer.PAIR_SCHEMA,
            "pair_id": pair_id,
            "group_id": group_id,
            "instruction": "do task",
            "compact_context": None,
            "chosen_target": chosen,
            "rejected_target": rejected,
            "evidence_weight": evidence,
        }

    def test_pair_compiler_requires_negative_parent_and_verified_positive_child(self):
        parent = {
            "trajectory_digest": "a" * 64,
            "request": "repair repository",
            "subject": "repo",
            "provenance": {"repository": "x/y", "base_sha": "1" * 40},
            "events": [{"type": "plan", "sequence": 2, "payload": {"action": "force-push"}}],
            "verification": [{"status": "failed", "independent": True, "evidence_digest": "f" * 64}],
            "outcome": {"status": "failed", "negative": True},
        }
        repair = {
            "trajectory_digest": "b" * 64,
            "parent_trajectory_digest": parent["trajectory_digest"],
            "request": "repair repository",
            "subject": "repo",
            "provenance": {"repository": "x/y", "base_sha": "1" * 40},
            "events": [{"type": "plan", "sequence": 2, "payload": {"action": "safe-rebase"}}],
            "verification": [{"status": "passed", "independent": True, "evidence_digest": "e" * 64}],
            "outcome": {"status": "completed", "negative": False},
        }
        pair = compiler.pair_from(
            parent,
            repair,
            {"negative": True, "admission_digest": "c" * 64},
            {"positive": True, "admission_digest": "d" * 64},
        )
        self.assertEqual(pair["schema"], compiler.PAIR_SCHEMA)
        self.assertNotEqual(pair["chosen_target"], pair["rejected_target"])
        self.assertGreater(pair["evidence_weight"], 1)
        body = dict(pair)
        claimed = body.pop("pair_digest")
        self.assertEqual(claimed, compiler.digest(body))

    def test_tokenization_masks_shared_prefix_for_preference_but_not_sft(self):
        tokenized = trainer.tokenize_pair(TinyTokenizer(), self.row("pair-test", "lineage-a"), 512)
        chosen_sft = [item for item in tokenized["chosen_sft_labels"] if item != -100]
        chosen_divergence = [item for item in tokenized["chosen_divergence_labels"] if item != -100]
        self.assertGreater(len(chosen_sft), len(chosen_divergence))
        self.assertEqual(tokenized["divergence_target_token"], 3)

    def test_post_divergence_tail_is_bounded(self):
        tokenized = trainer.tokenize_pair(
            TinyTokenizer(),
            self.row("pair-tail", "lineage-a", chosen="abcX" + "g" * 100, rejected="abcY" + "b" * 100),
            512,
            max_post_divergence_tokens=8,
        )
        self.assertLessEqual(tokenized["information_tokens"], 18)

    def test_budget_is_deterministic_and_lineage_atomic(self):
        rows = [
            self.row("pair-a1", "lineage-a", evidence=4),
            self.row("pair-a2", "lineage-a", evidence=4),
            self.row("pair-b1", "lineage-b", chosen="abcX" + "g" * 80, rejected="abcY" + "b" * 80, evidence=1),
        ]
        tokenized = [trainer.tokenize_pair(TinyTokenizer(), row, 512) for row in rows]
        first, receipt_one = trainer.select_budgeted_pairs(tokenized, fraction=0.4, minimum_pairs=1, seed=3407)
        second, receipt_two = trainer.select_budgeted_pairs(tokenized, fraction=0.4, minimum_pairs=1, seed=3407)
        self.assertEqual(receipt_one, receipt_two)
        selected = {item["pair_id"] for item in first}
        self.assertTrue({"pair-a1", "pair-a2"}.issubset(selected), "a repair lineage must be selected as one atomic unit")
        self.assertTrue(receipt_one["lineage_atomic"])

    def test_common_prefix_is_exact_and_deterministic(self):
        self.assertEqual(trainer.common_prefix_length([1, 2, 3], [1, 2, 4]), 2)
        self.assertEqual(trainer.common_prefix_length([1, 2], [1, 2, 3]), 2)

    def test_training_source_contains_real_budgeted_gradient_objective(self):
        source = (ROOT / "train_causal_divergence.py").read_text(encoding="utf-8")
        for marker in (
            "functional.logsigmoid",
            "POLICY_ONLY_OBJECTIVE",
            "select_budgeted_pairs",
            "use_rslora",
            "torch.cat",
            "get_peft_model",
            "trainer.train()",
            "load_in_4bit=True",
            '"promotion": "not-admitted"',
            "Refusing CPU fallback",
        ):
            self.assertIn(marker, source)

    def test_novelty_claim_is_bounded(self):
        source = (ROOT / "train_causal_divergence.py").read_text(encoding="utf-8")
        self.assertIn("not a claim of globally unique prior art", source)
        self.assertIn("without evaluation", source)


if __name__ == "__main__":
    unittest.main()
