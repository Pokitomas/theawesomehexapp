import unittest

from receipt_machine import Beam, Guard, Hypothesis, Ledger, Receipt, ReceiptError, Write, copy, set_value, swap


class ReceiptMachineTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            "cells": [3, 8, 1],
            "queue": [0, 2],
            "authority": "root",
        }

    def test_set_stores_only_destroyed_value_and_undoes_exactly(self):
        ledger = Ledger.start(self.state).apply(set_value(("cells", 0), 5))
        self.assertEqual(ledger.state["cells"], [5, 8, 1])
        self.assertEqual(ledger.commits[-1].inverse.writes, (Write(("cells", 0), 3),))
        self.assertEqual(ledger.undo().state, self.state)

    def test_copy_retains_only_overwritten_destination(self):
        receipt = copy(("cells", 0), ("cells", 2), self.state)
        ledger = Ledger.start(self.state).apply(receipt)
        self.assertEqual(ledger.state["cells"], [3, 8, 3])
        self.assertEqual(ledger.commits[-1].inverse.writes, (Write(("cells", 2), 1),))
        self.assertEqual(ledger.undo().state, self.state)

    def test_swap_is_exact_and_undoable(self):
        ledger = Ledger.start(self.state).apply(swap(("cells", 0), ("cells", 1), self.state))
        self.assertEqual(ledger.state["cells"], [8, 3, 1])
        self.assertEqual(ledger.undo().state, self.state)

    def test_guard_blocks_illegal_commit(self):
        receipt = Receipt(
            op="authorized-set",
            guards=(Guard(("authority",), "admin"),),
            writes=(Write(("cells", 0), 5),),
        )
        with self.assertRaises(ReceiptError):
            Ledger.start(self.state).apply(receipt)

    def test_duplicate_write_is_rejected(self):
        receipt = Receipt(
            op="bad",
            writes=(Write(("cells", 0), 5), Write(("cells", 0), 7)),
        )
        with self.assertRaises(ReceiptError):
            Ledger.start(self.state).apply(receipt)

    def test_hypotheses_remain_crisp_until_observation(self):
        beam = Beam.start(self.state).branch(
            lambda _: (
                (set_value(("cells", 0), 5, op="set-a"), 0.55),
                (set_value(("cells", 1), 5, op="set-b"), 0.45),
            )
        )
        self.assertEqual(len(beam.hypotheses), 2)
        self.assertEqual(
            {tuple(h.ledger.state["cells"]) for h in beam.hypotheses},
            {(5, 8, 1), (3, 5, 1)},
        )
        resolved = beam.observe(lambda state: state["cells"][1] == 5)
        self.assertEqual(len(resolved.hypotheses), 1)
        self.assertEqual(resolved.best().ledger.state["cells"], [3, 5, 1])

    def test_long_chain_has_no_state_drift(self):
        ledger = Ledger.start(self.state)
        receipts = []
        expected = list(self.state["cells"])
        for index in range(2000):
            slot = index % len(expected)
            value = (index * 17) % 101
            expected[slot] = value
            receipts.append(set_value(("cells", slot), value, op=f"set-{index}"))
        ledger = ledger.replay(receipts)
        self.assertEqual(ledger.state["cells"], expected)
        for _ in receipts:
            ledger = ledger.undo()
        self.assertEqual(ledger.state, self.state)


if __name__ == "__main__":
    unittest.main()
