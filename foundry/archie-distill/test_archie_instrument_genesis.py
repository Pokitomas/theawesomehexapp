#!/usr/bin/env python3
from __future__ import annotations

import unittest

import numpy as np

from archie_instrument_core import (
    BASE_NAMES,
    FORBIDDEN_WORDS,
    PRIMITIVE_NAMES,
    Program,
    evaluate_program,
    seed_programs,
    stable_json,
)
from archie_instrument_runtime import InstrumentRuntime


class InstrumentGenesisTest(unittest.TestCase):
    def test_language_contains_only_raw_generic_terminals(self) -> None:
        forbidden_terminals = {"family", "target", "render", "control", "hidden", "effect"}
        self.assertFalse(forbidden_terminals.intersection(PRIMITIVE_NAMES))
        self.assertTrue(set(BASE_NAMES).issubset(PRIMITIVE_NAMES))
        for program in seed_programs():
            text = stable_json(program.to_json()).lower()
            self.assertFalse(any(word in text for word in FORBIDDEN_WORDS))

    def test_program_executes_numeric_measurement(self) -> None:
        program = Program(
            "add",
            (
                Program("mul", (Program("leaf", value="action_x"), Program("leaf", value="last_action_x"))),
                Program("mul", (Program("leaf", value="action_y"), Program("leaf", value="last_action_y"))),
            ),
        )
        primitive = {name: np.zeros(3) for name in PRIMITIVE_NAMES}
        primitive.update({
            "action_x": np.asarray([1.0, 0.0, -1.0]),
            "action_y": np.asarray([0.0, 1.0, 0.0]),
            "last_action_x": np.asarray([1.0, 1.0, 1.0]),
            "last_action_y": np.asarray([0.0, 0.0, 0.0]),
        })
        np.testing.assert_allclose(evaluate_program(program, primitive), np.asarray([1.0, 0.0, -1.0]))

    def test_runtime_exposes_scores_not_genealogy(self) -> None:
        program = Program("mul", (Program("leaf", value="action_x"), Program("leaf", value="last_action_x")))
        width = len(BASE_NAMES) + 1
        pack = {
            "schema": "archie-instrument-pack/v1",
            "programs": [{"program": program.to_json(), "parents": ["ancestor"]}],
            "runtime": {
                "base_names": list(BASE_NAMES),
                "feature_mean": [0.0] * width,
                "feature_std": [1.0] * width,
                "counterfactual_coefficients": [0.0] * (width - 1) + [1.0],
                "intervention_coefficients": [0.0] * (width - 1) + [2.0],
            },
        }
        primitive = {name: np.zeros(2) for name in PRIMITIVE_NAMES}
        primitive["action_x"] = np.asarray([1.0, -1.0])
        primitive["last_action_x"] = np.asarray([1.0, 1.0])
        result = InstrumentRuntime(pack).score(primitive)
        self.assertEqual(set(result), {"counterfactual_consequence", "intervention_score"})
        np.testing.assert_allclose(result["counterfactual_consequence"], np.asarray([1.0, -1.0]))


if __name__ == "__main__":
    unittest.main()
