import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "train_kimi_reasoner", HERE / "train-kimi-reasoner.py"
)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class TrainKimiReasonerTests(unittest.TestCase):
    def row(self):
        return {
            "route": "compound",
            "active_clauses": 2,
            "compound": True,
            "operation": "draft then schedule",
            "target": "reply and meeting",
            "ordered_outcomes": ["draft the reply", "schedule the meeting"],
        }

    def test_enriches_reasoner_generation_target(self):
        graph, plan = MOD.enrich_target(
            {"route": "compound", "authority": "allow", "context": "ready"},
            {"response_action": "compose_ordered_actions"},
            self.row(),
        )
        self.assertEqual(graph["requested_route"], "compound")
        self.assertEqual(graph["active_clauses"], 2)
        self.assertTrue(graph["compound"])
        self.assertEqual(graph["operation"], "draft then schedule")
        self.assertEqual(graph["target"], "reply and meeting")
        self.assertEqual(plan["ordered_outcomes"], ["draft the reply", "schedule the meeting"])

    def test_ordinary_rows_are_unchanged(self):
        graph = {"route": "summary"}
        plan = {"response_action": "summarize"}
        actual_graph, actual_plan = MOD.enrich_target(graph, plan, {"route": "summary"})
        self.assertEqual(actual_graph, graph)
        self.assertEqual(actual_plan, plan)

    def test_incomplete_or_inconsistent_supervision_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "incomplete Kimi"):
            MOD.enrich_target({}, {}, {"route": "summary", "compound": False})
        with self.assertRaisesRegex(ValueError, "exactly match"):
            MOD.enrich_target({}, {}, {**self.row(), "route": "summary"})
        with self.assertRaisesRegex(ValueError, "at least two ordered outcomes"):
            MOD.enrich_target({}, {}, {**self.row(), "ordered_outcomes": ["only one"]})

    def test_patch_is_idempotent_and_used_by_target_builder(self):
        class FakeReasoner:
            @staticmethod
            def target_objects(row):
                return {"route": row["route"]}, {"response_action": "x"}

        MOD.install_patch(FakeReasoner)
        first = FakeReasoner.target_objects
        MOD.install_patch(FakeReasoner)
        self.assertIs(first, FakeReasoner.target_objects)
        graph, plan = FakeReasoner.target_objects(self.row())
        self.assertEqual(graph["operation"], "draft then schedule")
        self.assertEqual(len(plan["ordered_outcomes"]), 2)


if __name__ == "__main__":
    unittest.main()
