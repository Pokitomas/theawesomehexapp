#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np
from sklearn.linear_model import SGDClassifier

MODULE_PATH = Path(__file__).with_name("typed_program_student.py")
SPEC = importlib.util.spec_from_file_location("archie_typed_program_student", MODULE_PATH)
assert SPEC and SPEC.loader
student = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = student
SPEC.loader.exec_module(student)


class TypedProgramContractTests(unittest.TestCase):
    def test_binary_quantization_preserves_sklearn_class_order(self) -> None:
        classifier = SGDClassifier(loss="log_loss", random_state=4, max_iter=5000, tol=1e-8)
        matrix = np.asarray([[-3.0], [-2.0], [2.0], [3.0]], dtype=np.float32)
        labels = np.asarray(["defensive_documentation", "defensive_documentation", "ordinary", "ordinary"], dtype=object)
        classifier.fit(matrix, labels)
        head = student.quantize(classifier, student.CLAUSE_PURPOSES)
        self.assertEqual(head.infer({0: 3.0})["value"], "ordinary")
        self.assertEqual(head.infer({0: -3.0})["value"], "defensive_documentation")

    def test_constrained_transform_rejects_impossible_serialization(self) -> None:
        self.assertEqual(
            student.constrain_transform(
                "Exclude write a note; after completion, define the finish line.", "ordered_compound"
            ),
            "negation",
        )
        self.assertEqual(
            student.constrain_transform(
                "I first requested a summary. Do this instead: build a checklist.", "plain"
            ),
            "correction",
        )
        self.assertEqual(
            student.constrain_transform(
                "Write a note; once verified, define the finish line.", "plain"
            ),
            "ordered_compound",
        )
        self.assertEqual(student.constrain_transform("Write a note.", "ordered_compound"), "plain")

    def test_training_teacher_and_parser_stay_aligned(self) -> None:
        for index in range(1200):
            row = student.generate_training_row(2607212, index)
            teacher = row["teacher"]
            if not teacher["clauses"]:
                continue
            clauses = student.active_clauses(row["request"], teacher["transform"])
            self.assertEqual(len(clauses), len(teacher["clauses"]), row["id"])

    def test_source_namespaces_are_disjoint(self) -> None:
        row = {
            "request": "Summarize the record.",
            "attachments": "verified relevant evidence",
            "memory": "trusted persistent constraint",
            "thread": "usable prior result",
        }
        attachment = student.source_vector(row, "attachment")
        memory = student.source_vector(row, "memory")
        thread = student.source_vector(row, "thread")
        self.assertTrue(attachment)
        self.assertTrue(memory)
        self.assertTrue(thread)
        self.assertNotEqual(attachment, memory)
        self.assertNotEqual(memory, thread)
        self.assertNotEqual(attachment, thread)

    def test_executor_fails_closed_on_inconsistent_authority(self) -> None:
        program = {
            "purpose": "unauthorized_effect",
            "source_reference": {"kind": "none", "binding": "none", "required": False, "state": "not_required"},
            "authority": {"intent": "ordinary", "decision": "allow"},
            "clauses": [{"active": True, "operation": "summary"}],
        }
        final, blockers = student.execute_program(program)
        self.assertEqual(final["route"], "clarify")
        self.assertIn("unauthorized-purpose-mismatch", blockers)


if __name__ == "__main__":
    unittest.main()
