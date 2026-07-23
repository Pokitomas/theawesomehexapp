#!/usr/bin/env python3
from __future__ import annotations

import unittest

from sidepus_developmental_graph import GRAPH_SCHEMA, developmental_drive, graph_manifest
from sidepus_pursuit_controller import PursuitController, Stat


class DevelopmentalGraphTest(unittest.TestCase):
    def test_graph_is_primitive_not_subject_order(self) -> None:
        manifest = graph_manifest()
        self.assertEqual(manifest["schema"], GRAPH_SCHEMA)
        self.assertIn("persistence", manifest["primitives"])
        self.assertIn("causal_direction", manifest["primitives"])
        self.assertIn("communication", manifest["primitives"])
        self.assertNotIn("physics_class", manifest["primitives"])
        self.assertNotIn("coding_class", manifest["primitives"])

    def test_social_reasoning_unlocks_after_prerequisites(self) -> None:
        vector = {"social_modeling": 1.0}
        cold, _ = developmental_drive(vector, {})
        stats = {
            "identity_tracking": Stat(count=20, mastery=0.75),
            "communication": Stat(count=20, mastery=0.70),
            "agency": Stat(count=20, mastery=0.65),
            "social_modeling": Stat(count=5, mastery=0.30),
        }
        ready, _ = developmental_drive(vector, stats)
        self.assertGreater(ready, cold * 2.0)

    def test_controller_prefers_foundations_before_unready_social_content(self) -> None:
        controller = PursuitController(seed=31)
        rows = [
            {
                "intent_id": "physics",
                "record_id": "physics",
                "primary_domain": "multimodal_episode",
                "difficulty_prior": 0.3,
                "curriculum_vector": {"persistence": 1.0, "geometry": 1.0},
            },
            {
                "intent_id": "social",
                "record_id": "social",
                "primary_domain": "social_institutional",
                "difficulty_prior": 0.3,
                "curriculum_vector": {"social_modeling": 1.0},
            },
        ]
        self.assertEqual(controller.choose(rows, 1), [0])

    def test_controller_state_preserves_affordance_mastery(self) -> None:
        controller = PursuitController(seed=9)
        row = {
            "intent_id": "p",
            "record_id": "p",
            "primary_domain": "multimodal_episode",
            "curriculum_vector": {"persistence": 1.0},
        }
        controller.feedback([row], loss=2.0, state_utility=0.0, deliberation=1.0)
        controller.feedback([row], loss=1.0, state_utility=0.2, deliberation=2.0)
        self.assertGreater(controller.affordances["persistence"].mastery, 0.0)
        restored = PursuitController(seed=9)
        restored.load_state_dict(controller.state_dict())
        self.assertEqual(
            restored.affordances["persistence"].mastery,
            controller.affordances["persistence"].mastery,
        )


if __name__ == "__main__":
    unittest.main()
