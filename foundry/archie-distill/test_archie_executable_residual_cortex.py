#!/usr/bin/env python3
from __future__ import annotations

import unittest

from archie_executable_residual_cortex import (
    CortexConfig,
    Lesson,
    Skill,
    admit_lesson,
    canonical_programs,
    execute,
    synthetic_lessons,
)


class ExecutableResidualCortexTest(unittest.TestCase):
    def test_restricted_programs_execute_exactly(self) -> None:
        values = [3, 5, 8]
        self.assertEqual(execute({"op": "sum_mod", "modulus": 7}, values), 2)
        self.assertEqual(execute({"op": "maximum"}, values), 8)
        self.assertEqual(execute({"op": "count_even"}, values), 1)
        self.assertEqual(
            execute({"op": "affine_sum_mod", "scale": 3, "bias": 2, "modulus": 5}, values),
            0,
        )

    def test_hidden_court_rejects_plausible_wrong_skill(self) -> None:
        wrong = Skill(
            skill_id="sum-seven",
            description="Add the list modulo seven",
            program={"op": "sum_mod", "modulus": 8},
        )
        lesson = Lesson(
            skill=wrong,
            utterances=("sum modulo seven", "total under mod seven"),
            public_examples=(((1, 2), 3), ((2, 3), 5)),
        )
        receipt = admit_lesson(lesson, hidden_tests=128, seed=17)
        self.assertFalse(receipt["admitted"])
        self.assertTrue(receipt["hidden_failures"])

    def test_canonical_lessons_are_hidden_admissible(self) -> None:
        cfg = CortexConfig(
            hash_buckets=512,
            width=32,
            steps=1,
            batch_size=8,
            hidden_tests=32,
            train_paraphrases_per_skill=4,
            eval_paraphrases_per_skill=4,
            seeds=(17,),
            device="cpu",
        )
        lessons = synthetic_lessons(cfg, 17)
        self.assertEqual({lesson.skill.skill_id for lesson in lessons}, set(canonical_programs()))
        self.assertTrue(all(admit_lesson(lesson, hidden_tests=32, seed=17)["admitted"] for lesson in lessons))


if __name__ == "__main__":
    unittest.main()
