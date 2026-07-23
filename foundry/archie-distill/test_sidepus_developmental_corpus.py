from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from sidepus_developmental_corpus import DOMAINS, generate


class DevelopmentalCorpusTest(unittest.TestCase):
    def test_all_domains_are_materialized_without_hidden_truth_leakage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "inventory.jsonl"
            receipt = generate(root / "state", output, episodes_per_domain=2, steps=4, seed=17)
            rows = [json.loads(line) for line in output.read_text().splitlines() if line.strip()]
            self.assertEqual(receipt["records"], len(DOMAINS) * 2 * 4)
            self.assertEqual(set(DOMAINS), {row["domain"] for row in rows})
            for row in rows:
                self.assertIn("interpretation", row["channel_objects"])
                self.assertNotIn("interpretation", {"observation", "action_consequence"})
                hidden = row["channel_objects"]["interpretation"][0]
                self.assertEqual(hidden["visibility"], "hidden-generator-truth")
                self.assertTrue(row["rights"]["allow_training"])
                self.assertEqual(row["sequence_length"], 4)

    def test_generation_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            first, second = root / "a.jsonl", root / "b.jsonl"
            generate(root / "state", first, episodes_per_domain=1, steps=3, seed=99)
            generate(root / "state", second, episodes_per_domain=1, steps=3, seed=99)
            self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
