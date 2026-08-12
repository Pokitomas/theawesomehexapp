#!/usr/bin/env python3
from __future__ import annotations

import http.server
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-local-semantic-broker-v3.py"
SPEC = importlib.util.spec_from_file_location("archie_local_semantic_broker_v3_initiative_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
V3 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = V3
SPEC.loader.exec_module(V3)


def append(path: pathlib.Path, actor: str, text: str, **extra) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"from": actor, "text": text, **extra}, ensure_ascii=False) + "\n")


class FakeCompletionServer:
    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.requests: list[dict] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                owner.requests.append(request)
                if not owner.responses:
                    self.send_response(500)
                    self.end_headers()
                    return
                text = owner.responses.pop(0)
                payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": text}}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format, *_args):
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class BrokerInitiativeCourt(unittest.TestCase):
    def make_broker(self, root: pathlib.Path, wire: pathlib.Path, *, port: int = 1):
        events = root / "events.jsonl"
        state = root / "state.json"
        receipts = root / "receipts.jsonl"
        events.touch(); receipts.touch()
        broker = V3.M.Broker(events=events, wire=wire, state=state, receipts=receipts, pty="", host="127.0.0.1", port=port, model="test", turns=8, burst_ms=0, max_tokens=32)
        return broker, receipts

    def test_live_delegation_transfers_initiative_inside_broker_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td); wire = root / "wire.jsonl"; wire.touch()
            append(wire, "kai", "Can you choose? Can you decide?")
            append(wire, "gpt56sol", "I'll decide. Let's explore something interesting. What interests you?", type="semantic_message")
            append(wire, "kai", "I can't decide! That's what I was hoping you would enumerate")
            append(wire, "gpt56sol", "What would you like to explore?", type="semantic_message")
            broker, receipts = self.make_broker(root, wire)
            system = broker.messages("You choose.")[0]["content"]
            self.assertIn("INITIATIVE TRANSFER", system)
            self.assertIn("Choose one concrete safe topic/action yourself", system)
            self.assertIn("Do not ask the user what they want", system)
            rows = [json.loads(line) for line in receipts.read_text("utf-8").splitlines() if line.strip()]
            initiative = [row for row in rows if row.get("kind") == "initiative_transfer"]
            self.assertEqual(len(initiative), 1)
            self.assertGreaterEqual(int(initiative[0]["prior_failed_loops"]), 2)

    def test_normal_question_gets_no_initiative_projection(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td); wire = root / "wire.jsonl"; wire.touch()
            broker, receipts = self.make_broker(root, wire)
            messages = broker.messages("What is the orbital period of Mars?")
            self.assertNotIn("INITIATIVE TRANSFER", messages[0]["content"])
            rows = [json.loads(line) for line in receipts.read_text("utf-8").splitlines() if line.strip()]
            self.assertFalse(any(row.get("kind") == "initiative_transfer" for row in rows))

    def test_live_bad_draft_is_buffered_and_repaired_before_wire(self):
        server = FakeCompletionServer(["I'll decide. Let's explore the mysteries of the universe. What interests you?"])
        try:
            with tempfile.TemporaryDirectory() as td:
                root = pathlib.Path(td); wire = root / "wire.jsonl"; wire.touch()
                broker, receipts = self.make_broker(root, wire, port=server.port)
                broker.epoch = 1
                writes: list[str] = []; broker.pty_write = writes.append
                broker.generate(1, "You choose.", V3.M.now_ns(), 1)
                self.assertEqual(len(server.requests), 1)
                self.assertIs(server.requests[0]["stream"], False)
                rows = [json.loads(line) for line in wire.read_text("utf-8").splitlines() if line.strip()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["text"], "I'll decide. Let's explore the mysteries of the universe.")
                self.assertEqual(rows[0]["initiative_boundary"], "buffered-repair")
                self.assertNotIn("What interests you", "".join(writes))
                receipt_rows = [json.loads(line) for line in receipts.read_text("utf-8").splitlines() if line.strip()]
                self.assertTrue(any(row.get("kind") == "initiative_repair" for row in receipt_rows))
                candidates = [row for row in receipt_rows if row.get("kind") == "initiative_candidate"]
                self.assertEqual(candidates[-1]["reason"], "delegated-choice-returned-to-user")
        finally:
            server.close()

    def test_empty_performative_draft_retries_once_then_commits_concrete_choice(self):
        server = FakeCompletionServer(["I'll decide.", "I'll choose orbital resonance. Start with why three-body systems trade angular momentum."])
        try:
            with tempfile.TemporaryDirectory() as td:
                root = pathlib.Path(td); wire = root / "wire.jsonl"; wire.touch()
                broker, receipts = self.make_broker(root, wire, port=server.port)
                broker.epoch = 7
                broker.generate(7, "You decide.", V3.M.now_ns(), 1)
                self.assertEqual(len(server.requests), 2)
                self.assertTrue(all(request["stream"] is False for request in server.requests))
                self.assertIn("DELEGATED-CHOICE RETRY", server.requests[1]["messages"][0]["content"])
                rows = [json.loads(line) for line in wire.read_text("utf-8").splitlines() if line.strip()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["initiative_boundary"], "buffered-allow")
                self.assertIn("orbital resonance", rows[0]["text"])
                receipt_rows = [json.loads(line) for line in receipts.read_text("utf-8").splitlines() if line.strip()]
                candidates = [row for row in receipt_rows if row.get("kind") == "initiative_candidate"]
                self.assertEqual([row["attempt"] for row in candidates], [1, 2])
                self.assertEqual(candidates[0]["reason"], "delegated-choice-without-substantive-action")
                self.assertTrue(candidates[1]["allow"])
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
