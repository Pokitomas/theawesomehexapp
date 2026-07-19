#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("information_budgeted_rslora", ROOT / "information_budgeted_rslora.py")
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)

weave_spec = importlib.util.spec_from_file_location("token_compute_weave", ROOT / "token_compute_weave.py")
weave = importlib.util.module_from_spec(weave_spec)
assert weave_spec and weave_spec.loader
sys.modules[weave_spec.name] = weave
weave_spec.loader.exec_module(weave)


class TinyTokenizer:
    eos_token_id = 97
    pad_token_id = 0
    chat_template = None

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [ord(character) % 89 + 1 for character in text]}


def row(pair_id: str, chosen: str, rejected: str, group: str = "g", weight: float = 1.0):
    return {
        "schema": module.PAIR_SCHEMA,
        "pair_id": pair_id,
        "pair_digest": (pair_id[0] if pair_id else "a") * 64,
        "group_id": group,
        "instruction": "repair the repository safely with a long contextual request " * 8,
        "compact_context": {"repo": "x/y", "facts": list(range(20))},
        "chosen_target": chosen,
        "rejected_target": rejected,
        "evidence_weight": weight,
    }


class InformationBudgetedRSLoRATest(unittest.TestCase):
    def test_causal_fork_replay_keeps_divergence_and_reduces_attention_area(self):
        item = module.tokenize_causal_fork(
            TinyTokenizer(),
            row("a-pair", "shared-prefix-" * 30 + "GOOD" * 80, "shared-prefix-" * 30 + "BAD" * 80),
            {
                "max_seq_length": 160,
                "prompt_replay_tokens": 48,
                "prompt_head_tokens": 8,
                "shared_prefix_replay_tokens": 24,
                "max_divergence_tokens": 80,
            },
        )
        self.assertTrue(any(value != -100 for value in item["chosen_divergence_labels"]))
        self.assertTrue(any(value != -100 for value in item["rejected_divergence_labels"]))
        self.assertLess(item["attention_area_cost"], item["tokenization"]["original"]["attention_area"])
        self.assertLessEqual(len(item["chosen_input_ids"]), 160)
        self.assertLessEqual(len(item["rejected_input_ids"]), 160)
        self.assertEqual(item["chosen_sft_labels"], item["chosen_divergence_labels"])

    def test_lineage_groups_remain_atomic_while_attention_cost_balances(self):
        rows = [
            row("a1", "abcX" + "g" * 20, "abcY" + "b" * 20, "lineage-a", 2),
            row("a2", "abcX" + "g" * 30, "abcY" + "b" * 30, "lineage-a", 2),
            row("b1", "abcX" + "g" * 10, "abcY" + "b" * 10, "lineage-b", 1),
            row("c1", "abcX" + "g" * 15, "abcY" + "b" * 15, "lineage-c", 1),
        ]
        shards = module.information_balanced_shards(rows, TinyTokenizer(), 2, 3407, 0, module.DEFAULT_POLICY)
        locations = {}
        for shard in shards:
            for item in shard["rows"]:
                locations.setdefault(item["group_id"], set()).add(shard["index"])
        self.assertEqual(locations["lineage-a"], {next(iter(locations["lineage-a"]))})
        self.assertTrue(all(len(value) == 1 for value in locations.values()))

    def test_cached_reference_scalars_match_live_reference_loss(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch unavailable")
        torch.manual_seed(4)
        chosen = torch.randn(2, 7, 19, requires_grad=True)
        rejected = torch.randn(2, 7, 19, requires_grad=True)
        ref_chosen_logits = torch.randn(2, 7, 19)
        ref_rejected_logits = torch.randn(2, 7, 19)
        chosen_labels = torch.tensor([[-100, -100, 1, 2, 3, 4, 5], [-100, -100, 2, 3, 4, 5, 6]])
        rejected_labels = torch.tensor([[-100, -100, 6, 7, 8, 9, 10], [-100, -100, 7, 8, 9, 10, 11]])
        ref_chosen = module.sequence_log_prob(ref_chosen_logits, chosen_labels)
        ref_rejected = module.sequence_log_prob(ref_rejected_logits, rejected_labels)
        loss_a, metrics_a = module.causal_fork_loss(
            policy_chosen_logits=chosen,
            policy_rejected_logits=rejected,
            reference_chosen_logp=ref_chosen,
            reference_rejected_logp=ref_rejected,
            chosen_labels=chosen_labels,
            rejected_labels=rejected_labels,
            evidence_weight=torch.tensor([1.0, 2.0]),
            beta=0.1,
            margin=0.2,
            sft_weight=0.35,
        )
        cached_chosen = torch.tensor([float(value) for value in ref_chosen])
        cached_rejected = torch.tensor([float(value) for value in ref_rejected])
        loss_b, metrics_b = module.causal_fork_loss(
            policy_chosen_logits=chosen,
            policy_rejected_logits=rejected,
            reference_chosen_logp=cached_chosen,
            reference_rejected_logp=cached_rejected,
            chosen_labels=chosen_labels,
            rejected_labels=rejected_labels,
            evidence_weight=torch.tensor([1.0, 2.0]),
            beta=0.1,
            margin=0.2,
            sft_weight=0.35,
        )
        self.assertTrue(torch.allclose(loss_a, loss_b, atol=1e-7, rtol=1e-7))
        self.assertTrue(torch.allclose(metrics_a["causal_margin"], metrics_b["causal_margin"], atol=1e-7, rtol=1e-7))
        loss_b.backward()
        self.assertGreater(float(chosen.grad.abs().sum()), 0)
        self.assertGreater(float(rejected.grad.abs().sum()), 0)

    def test_token_compute_maps_into_archie_replay_regions(self):
        policy = weave.policy_from_token_compute(token_compute=2 * 100 * 512 * 512, training_rows=100)
        self.assertEqual(policy.max_seq_length, 512)
        self.assertLessEqual(
            policy.prompt_replay_tokens + policy.shared_prefix_replay_tokens + policy.max_divergence_tokens,
            policy.max_seq_length,
        )
        self.assertGreater(policy.max_divergence_tokens, policy.prompt_replay_tokens)
        self.assertEqual(policy.effective_attention_area, 2 * 100 * 512 * 512)

    def test_token_compute_is_clamped_without_claiming_training(self):
        policy = weave.policy_from_token_compute(token_compute=10**18, training_rows=1, max_seq_cap=1024)
        self.assertEqual(policy.max_seq_length, 1024)
        source = (ROOT / "token_compute_weave.py").read_text(encoding="utf-8")
        self.assertIn('"promotion": "not-admitted"', source)
        self.assertIn("token-compute-to-causal-fork-policy/v1", source)

    def test_source_contains_explicit_rslora_fallback_and_no_promotion(self):
        source = (ROOT / "information_budgeted_rslora.py").read_text(encoding="utf-8")
        for marker in (
            '"use_rslora"',
            'installed-peft-loraconfig-has-no-use_rslora',
            '"promotion": "not-admitted"',
            'stacked_chosen_rejected_forward',
            'reference-cache-receipt.json',
            'balance_metric": "replayed_attention_area"',
        ):
            self.assertIn(marker, source)
        fuser = (ROOT / "fuse_information_budgeted_adapters.py").read_text(encoding="utf-8")
        self.assertIn('fused_config["use_rslora"] = False', fuser)
        self.assertIn('source_scaling_absorbed_into_delta_factors', fuser)


if __name__ == "__main__":
    unittest.main()
