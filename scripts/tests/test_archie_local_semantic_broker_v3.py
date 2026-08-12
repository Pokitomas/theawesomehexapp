#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-local-semantic-broker-v3.py"
SPEC = importlib.util.spec_from_file_location("archie_local_semantic_broker_v3_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
V3 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = V3
SPEC.loader.exec_module(V3)


def append(path: pathlib.Path, actor: str, text: str, **extra):
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"from": actor, "text": text, **extra}, ensure_ascii=False) + "\n")


class EpisodicBoundaryCourt(unittest.TestCase):
    def make_broker(self, root: pathlib.Path, wire: pathlib.Path):
        events = root / "events.jsonl"
        state = root / "state.json"
        receipts = root / "receipts.jsonl"
        events.touch()
        receipts.touch()
        return V3.M.Broker(
            events=events,
            wire=wire,
            state=state,
            receipts=receipts,
            pty="",
            host="127.0.0.1",
            port=1,
            model="test",
            turns=3,
            burst_ms=0,
            max_tokens=32,
        )

    def test_big_prompt_survives_acknowledgement_chunking(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            wire = root / "wire.jsonl"
            wire.touch()
            chunks = [
                "BIGPROMPT begins: To replicate frontier intelligence locally, attack the memory wall rather than merely scaling weights.",
                "BIGPROMPT section two: replace gratuitous floating point and dense movement only when a matched representation court wins.",
                "BIGPROMPT section three: formal-looking prose is not proof; grounded claims need an external verifier or receipt.",
                "BIGPROMPT section four: fixed finite state cannot losslessly retain every arbitrary unbounded history; preserve exact residual evidence outside it.",
            ]
            for chunk in chunks:
                append(wire, "kai", chunk)
                append(wire, "gpt56sol", "Acknowledged.", type="semantic_message")
            append(wire, "kai", "Done.")
            append(wire, "gpt56sol", "I should attack each absolute with a falsifiable court.", type="semantic_message")
            current = "Recite BIGPROMPT as well as you can recall"
            # Mirror the current turn first, matching the live terminal-wire race.
            append(wire, "kai", current)

            broker = self.make_broker(root, wire)
            messages = broker.messages(current)
            system = messages[0]["content"]
            for chunk in chunks:
                self.assertIn(chunk, system)
            self.assertIn("EPISODIC EVIDENCE", system)
            # The current query is present once as the actual user turn, not
            # projected into the system memory block as a fake memory hit.
            self.assertEqual(messages[-1], {"role": "user", "content": current})
            memory_block = system.split("EPISODIC EVIDENCE", 1)[1]
            self.assertNotIn(current, memory_block)

    def test_unrelated_turn_does_not_force_episode_projection(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            wire = root / "wire.jsonl"
            wire.touch()
            append(wire, "kai", "ARCHIE_SPECIAL_MEMORY_ANCHOR contains an exact retained object.")
            append(wire, "gpt56sol", "I have it.", type="semantic_message")
            broker = self.make_broker(root, wire)
            messages = broker.messages("what is two plus two")
            self.assertNotIn("ARCHIE_SPECIAL_MEMORY_ANCHOR", messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
