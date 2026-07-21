from __future__ import annotations

import unittest

from archie_distill.core import (
    SCHEMA_EVALUATION,
    choose_consensus,
    extract_final,
    normalize_answer,
    score_answer,
    select_best,
    should_verify,
)


class CoreTests(unittest.TestCase):
    def test_extract_final_removes_tagged_trace(self) -> None:
        answer, confidence = extract_final("<think>discard this trace</think>Final answer: 323")
        self.assertEqual(answer, "323")
        self.assertIsNone(confidence)

    def test_extract_final_drops_trace_json_fields(self) -> None:
        answer, confidence = extract_final(
            '{"analysis":"discard","answer":"Paris","confidence":0.9}'
        )
        self.assertEqual(answer, "Paris")
        self.assertEqual(confidence, 0.9)

    def test_consensus_prefers_majority(self) -> None:
        winner, state = choose_consensus(
            [
                {"teacher_id": "a", "priority": 0, "answer": "Paris"},
                {"teacher_id": "b", "priority": 1, "answer": "paris."},
                {"teacher_id": "c", "priority": 2, "answer": "Lyon"},
            ],
            max_output_tokens=32,
        )
        self.assertEqual(normalize_answer(winner["answer"]), "paris")
        self.assertEqual(state["agreement"], 2)
        self.assertEqual(state["distinct_answers"], 2)

    def test_verification_sampling_is_deterministic(self) -> None:
        first = should_verify("sample-1", seed=7, verify_rate=0.4)
        second = should_verify("sample-1", seed=7, verify_rate=0.4)
        self.assertEqual(first, second)
        self.assertFalse(should_verify("sample-1", seed=7, verify_rate=0.0))
        self.assertTrue(should_verify("sample-1", seed=7, verify_rate=1.0))

    def test_reference_score(self) -> None:
        exact = score_answer("New York", ["new york"])
        partial = score_answer("York", ["New York"])
        self.assertEqual(exact["combined"], 1.0)
        self.assertGreater(partial["token_f1"], 0.0)
        self.assertLess(partial["combined"], exact["combined"])

    def test_select_best_uses_score_then_token_cost(self) -> None:
        receipts = [
            {
                "schema": SCHEMA_EVALUATION,
                "receipt_digest": "one",
                "metrics": {"combined": 0.9, "exact": 0.8},
                "generated_tokens": 100,
                "adapter": {"digest": "a"},
            },
            {
                "schema": SCHEMA_EVALUATION,
                "receipt_digest": "two",
                "metrics": {"combined": 0.9, "exact": 0.8},
                "generated_tokens": 80,
                "adapter": {"digest": "b"},
            },
        ]
        self.assertEqual(select_best(receipts, minimum_score=0.8)["receipt_digest"], "two")
        with self.assertRaises(ValueError):
            select_best(receipts, minimum_score=0.95)


if __name__ == "__main__":
    unittest.main()
