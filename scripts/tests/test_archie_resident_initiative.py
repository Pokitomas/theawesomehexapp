#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-resident-initiative.py"
SPEC = importlib.util.spec_from_file_location("archie_resident_initiative_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
I = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = I
SPEC.loader.exec_module(I)


class ResidentInitiativeCourt(unittest.TestCase):
    def test_exact_live_delegation_failures_are_detected(self):
        cases = [
            ("Can you choose? Can you decide?", "I'll decide. What interests you?"),
            ("I can't decide! That's what I was hoping you would enumerate", "What would you like to explore?"),
            ("Errhh nah. Choose a subject to think about", "What would you like to explore?"),
            ("You choose.", "I'll decide. What interests you?"),
        ]
        for user, reply in cases:
            with self.subTest(user=user):
                self.assertTrue(I.delegates_choice(user))
                self.assertTrue(I.asks_user_to_choose(reply))
                self.assertTrue(I.delegation_failure(user, reply))
                self.assertFalse(I.gate_candidate(user, reply)["allow"])

    def test_delegation_transfers_initiative_instead_of_forcing_a_topic(self):
        directive = I.initiative_directive("You choose.")
        self.assertIn("Choose one concrete safe topic/action yourself", directive)
        self.assertIn("Do not ask the user what they want", directive)
        self.assertNotIn("planets", directive.lower())
        self.assertNotIn("universe", directive.lower())

    def test_live_failure_can_preserve_model_owned_choice_without_hardcoding(self):
        draft = "I'll decide. Let's explore the mysteries of the universe. What interests you?"
        self.assertFalse(I.gate_candidate("You choose.", draft)["allow"])
        repaired = I.repair_delegated_candidate(draft)
        self.assertEqual(repaired, "I'll decide. Let's explore the mysteries of the universe.")
        self.assertTrue(I.has_substantive_initiative(repaired))
        self.assertTrue(I.gate_candidate("You choose.", repaired)["allow"])

    def test_performative_decision_without_action_is_not_progress(self):
        for draft in ("I'll decide.", "Sure. I'll choose.", "Okay."):
            with self.subTest(draft=draft):
                gate = I.gate_candidate("You choose.", draft)
                self.assertFalse(gate["allow"])
                self.assertEqual(gate["reason"], "delegated-choice-without-substantive-action")
                self.assertEqual(I.repair_delegated_candidate(draft), "")

    def test_concrete_self_choice_passes(self):
        draft = "I'll choose atmospheric escape. Start with why hydrogen leaves a warm planet first."
        gate = I.gate_candidate("You decide.", draft)
        self.assertTrue(gate["allow"])
        self.assertTrue(gate["candidate_has_substantive_initiative"])

    def test_useful_question_is_not_globally_banned(self):
        user = "Can you delete the old deployment?"
        reply = "Which deployment ID do you mean?"
        self.assertFalse(I.delegates_choice(user))
        self.assertFalse(I.delegation_failure(user, reply))
        self.assertTrue(I.gate_candidate(user, reply)["allow"])
        self.assertEqual(I.initiative_directive(user), "")

    def test_changed_user_state_restores_action_eligibility(self):
        history = [
            {"role": "user", "content": "You choose."},
            {"role": "assistant", "content": "What interests you?"},
            {"role": "user", "content": "Actually let's do planets."},
            {"role": "assistant", "content": "Okay, starting with atmospheric escape."},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "You choose."), 0)

    def test_repeated_no_progress_loop_accumulates_pressure(self):
        history = [
            {"role": "user", "content": "You choose."},
            {"role": "assistant", "content": "What interests you?"},
            {"role": "user", "content": "I can't decide. You decide."},
            {"role": "assistant", "content": "What would you like to explore?"},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "You choose."), 2)
        directive = I.initiative_directive("You choose.", history)
        self.assertIn("no-progress preference loops=2", directive)

    def test_productive_repetition_is_preserved(self):
        history = [
            {"role": "user", "content": "Keep compiling the next shard."},
            {"role": "assistant", "content": "Compiled shard 7; continuing."},
            {"role": "user", "content": "Keep going."},
            {"role": "assistant", "content": "Compiled shard 8; continuing."},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "Keep going."), 0)
        self.assertTrue(I.gate_candidate("Keep going.", "Compiled shard 9.", history)["allow"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
