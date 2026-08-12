#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, pathlib, sys, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-resident-initiative.py"
SPEC = importlib.util.spec_from_file_location("archie_resident_initiative_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
I = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = I; SPEC.loader.exec_module(I)

class ResidentInitiativeCourt(unittest.TestCase):
    def test_exact_live_failures(self):
        cases = [
            ("Can you choose? Can you decide?", "I'll decide. What interests you?"),
            ("I can't decide! That's what I was hoping you would enumerate", "What would you like to explore?"),
            ("Errhh nah. Choose a subject to think about", "What would you like to explore?"),
            ("You choose.", "I'll decide. What interests you?"),
        ]
        for user, reply in cases:
            self.assertTrue(I.delegates_choice(user)); self.assertTrue(I.delegation_failure(user, reply)); self.assertFalse(I.gate_candidate(user, reply)["allow"])

    def test_prompt_transfers_initiative_without_hardcoded_topic(self):
        d = I.initiative_directive("You choose.")
        self.assertIn("Choose one concrete safe topic/action yourself", d); self.assertIn("Do not ask the user what they want", d)
        self.assertNotIn("planets", d.lower()); self.assertNotIn("universe", d.lower())

    def test_repair_preserves_model_owned_choice(self):
        draft = "I'll decide. Let's explore the mysteries of the universe. What interests you?"
        repaired = I.repair_delegated_candidate(draft)
        self.assertEqual(repaired, "I'll decide. Let's explore the mysteries of the universe.")
        self.assertTrue(I.gate_candidate("You choose.", repaired)["allow"])

    def test_performative_decision_is_not_progress(self):
        for draft in ("I'll decide.", "Sure. I'll choose.", "Okay."):
            gate = I.gate_candidate("You choose.", draft)
            self.assertFalse(gate["allow"]); self.assertEqual(gate["reason"], "delegated-choice-without-substantive-action"); self.assertEqual(I.repair_delegated_candidate(draft), "")

    def test_concrete_choice_passes(self):
        self.assertTrue(I.gate_candidate("You decide.", "I'll choose atmospheric escape. Start with why hydrogen leaves a warm planet first.")["allow"])

    def test_normal_question_not_banned(self):
        self.assertTrue(I.gate_candidate("Can you delete the old deployment?", "Which deployment ID do you mean?")["allow"])

    def test_changed_state_resets_loop(self):
        history = [
            {"role":"user","content":"You choose."},{"role":"assistant","content":"What interests you?"},
            {"role":"user","content":"Actually let's do planets."},{"role":"assistant","content":"Starting with atmospheric escape."},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "You choose."), 0)

    def test_repeated_no_progress_accumulates(self):
        history = [
            {"role":"user","content":"You choose."},{"role":"assistant","content":"What interests you?"},
            {"role":"user","content":"I can't decide. You decide."},{"role":"assistant","content":"What would you like to explore?"},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "You choose."), 2)

    def test_productive_repeat_preserved(self):
        history = [
            {"role":"user","content":"Keep compiling the next shard."},{"role":"assistant","content":"Compiled shard 7; continuing."},
            {"role":"user","content":"Keep going."},{"role":"assistant","content":"Compiled shard 8; continuing."},
        ]
        self.assertEqual(I.trailing_failed_delegations(history, "Keep going."), 0)

if __name__ == "__main__": unittest.main(verbosity=2)
