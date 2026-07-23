#!/usr/bin/env python3
from __future__ import annotations

import unittest

import torch

from sidepus_pursuit_controller import PursuitController
from sidepus_pursuit_stream import PursuitExperienceStream


def bare_stream(capacity: int = 2) -> PursuitExperienceStream:
    stream = object.__new__(PursuitExperienceStream)
    stream.rows = []
    stream.source_cursor = 0
    stream.consumed = 0
    stream.reservoir = []
    stream.controller = PursuitController(seed=17)
    stream.state_bank_capacity = capacity
    stream.state_bank = {}
    stream.state_bank_order = []
    return stream


class ForeignStateBankTest(unittest.TestCase):
    def test_foreign_state_is_from_another_thread(self) -> None:
        stream = bare_stream()
        stream.remember_state(
            ["episode-a"],
            torch.full((1, 3, 4), 1.0),
            torch.full((1, 2, 4), 2.0),
        )
        world, plastic, threads = stream.foreign_state(["episode-a"], torch.device("cpu"))
        self.assertIsNone(world)
        self.assertIsNone(plastic)
        self.assertIsNone(threads)

        stream.remember_state(
            ["episode-b"],
            torch.full((1, 3, 4), 7.0),
            torch.full((1, 2, 4), 9.0),
        )
        world, plastic, threads = stream.foreign_state(["episode-a"], torch.device("cpu"))
        self.assertEqual(threads, ["episode-b"])
        self.assertTrue(torch.equal(world, torch.full((1, 3, 4), 7.0)))
        self.assertTrue(torch.equal(plastic, torch.full((1, 2, 4), 9.0)))

    def test_bank_is_bounded_and_checkpointable(self) -> None:
        stream = bare_stream(capacity=2)
        for index, name in enumerate(("a", "b", "c"), 1):
            stream.remember_state(
                [name],
                torch.full((1, 2, 3), float(index)),
                torch.full((1, 1, 3), float(index + 10)),
            )
        self.assertEqual(stream.state_bank_order, ["b", "c"])
        self.assertNotIn("a", stream.state_bank)

        payload = stream.state_dict()
        restored = bare_stream(capacity=2)
        restored.load_state_dict(payload)
        self.assertEqual(restored.state_bank_order, ["b", "c"])
        world, plastic, threads = restored.foreign_state(["b"], torch.device("cpu"))
        self.assertEqual(threads, ["c"])
        self.assertTrue(torch.equal(world, torch.full((1, 2, 3), 3.0)))
        self.assertTrue(torch.equal(plastic, torch.full((1, 1, 3), 13.0)))


if __name__ == "__main__":
    unittest.main()
