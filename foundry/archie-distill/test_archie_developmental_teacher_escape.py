#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from archie_developmental_teacher_escape import AffineWorld, Batch, Config, Student


class DevelopmentalTeacherEscapeTest(unittest.TestCase):
    def test_all_surface_families_are_exactly_generated(self) -> None:
        world = AffineWorld(17)
        batch = world.sample(64, families=tuple(range(8)), seed=29)
        self.assertEqual(batch.tokens.shape, (64, 10))
        self.assertTrue(batch.answer.ge(0).all())
        self.assertTrue(batch.answer.lt(13).all())
        self.assertTrue(set(batch.family.tolist()).issubset(set(range(8))))

    def test_teacher_and_transfer_families_are_disjoint(self) -> None:
        world = AffineWorld(17)
        teacher = world.sample(128, families=(0, 1, 2, 3), seed=31)
        transfer = world.sample(128, families=(4, 5, 6, 7), seed=43)
        self.assertTrue(teacher.family.lt(4).all())
        self.assertTrue(transfer.family.ge(4).all())

    def test_student_forward_is_finite(self) -> None:
        cfg = Config(width=32, layers=1, heads=4, teacher_examples=64, autonomous_rounds=2,
                     autonomous_candidates=64, autonomous_examples=16, train_steps_per_round=1,
                     batch_size=8, seeds=(17,), eval_examples=32, device="cpu")
        model = Student(cfg)
        batch = AffineWorld(17).sample(8, families=(0, 1, 2, 3), seed=31)
        output = model(batch)
        self.assertEqual(output["answer_logits"].shape, (8, 13))
        self.assertTrue(torch.isfinite(output["answer_logits"]).all())


if __name__ == "__main__":
    unittest.main()
