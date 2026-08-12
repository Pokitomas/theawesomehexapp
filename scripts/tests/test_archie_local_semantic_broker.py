#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-local-semantic-broker.py"
SPEC = importlib.util.spec_from_file_location("archie_local_semantic_broker_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


class FakeConnection:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class BrokerCourt(unittest.TestCase):
    def test_terminal_text_is_fail_closed(self):
        self.assertEqual(M.terminal_text({"source": "terminal", "kind": "user_text", "payload": {"text": " yo "}}), "yo")
        self.assertEqual(M.terminal_text({"source": "audio", "kind": "user_text", "payload": {"text": "yo"}}), "")
        self.assertEqual(M.terminal_text({"source": "terminal", "kind": "noise", "payload": {"text": "yo"}}), "")

    def test_room_history_separates_semantics_from_control_plane(self):
        self.assertTrue(M.semantic_room_event({"from": "kai", "text": "hello"}))
        self.assertTrue(M.semantic_room_event({"from": "gpt56sol", "type": "semantic_message", "text": "sup"}))
        self.assertFalse(M.semantic_room_event({"from": "gpt56sol", "text": "@all restart gpu"}))
        self.assertFalse(M.semantic_room_event({"from": "claude", "text": "host chatter"}))

    def test_seed_history_preserves_only_semantic_turns(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "wire.jsonl"
            rows = [
                {"from": "kai", "text": "one"},
                {"from": "gpt56sol", "text": "@all control"},
                {"from": "gpt56sol", "type": "semantic_message", "text": "two"},
                {"from": "other", "text": "noise"},
            ]
            p.write_text("".join(json.dumps(row) + "\n" for row in rows), "utf-8")
            hist = list(M.seed_history(p, 5))
            self.assertEqual(hist, [
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": "two"},
            ])

    def test_new_input_preempts_active_stream_before_pending_dispatch(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            broker = M.Broker(
                events=root / "events.jsonl",
                wire=root / "wire.jsonl",
                state=root / "state.json",
                receipts=root / "receipts.jsonl",
                pty="",
                host="127.0.0.1",
                port=1,
                model="local",
                turns=2,
                burst_ms=15,
                max_tokens=8,
            )
            fake = FakeConnection()
            broker.active_conn = fake
            broker.active_epoch = 7
            broker.epoch = 7
            broker.on_input("new words", M.now_ns())
            self.assertTrue(fake.closed)
            self.assertEqual(broker.epoch, 8)
            self.assertIsNone(broker.active_conn)
            self.assertIsNone(broker.active_epoch)
            self.assertEqual(broker.counters["cancelled"], 1)
            self.assertEqual([text for text, _stamp in broker.pending], ["new words"])
            receipt_rows = [json.loads(line) for line in (root / "receipts.jsonl").read_text().splitlines()]
            self.assertEqual(receipt_rows[0]["kind"], "cancel")
            self.assertEqual(receipt_rows[1]["kind"], "input")


if __name__ == "__main__":
    unittest.main()
