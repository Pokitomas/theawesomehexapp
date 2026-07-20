import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("calibrate-route-vetoes.py")
spec = importlib.util.spec_from_file_location("calibrate_route_vetoes", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CalibrationTest(unittest.TestCase):
    def test_disables_unsafe_veto(self):
        rows = [
            {"route_correct": True, "score": .99, "truth": False},
            {"route_correct": True, "score": .98, "truth": False},
            {"route_correct": True, "score": .2, "truth": True},
        ]
        result = module.choose_threshold(rows, "score", "truth", mode="veto", precision_floor=.99, retention_floor=1.0)
        self.assertTrue(result.get("disabled", False))

    def test_selects_high_precision_promotion(self):
        rows = [
            {"route_correct": False, "score": .95, "truth": True},
            {"route_correct": True, "score": .9, "truth": True},
            {"route_correct": True, "score": .1, "truth": False},
        ]
        result = module.choose_threshold(rows, "score", "truth", mode="promotion", precision_floor=.95, retention_floor=1.0)
        self.assertTrue(result["eligible"])
        self.assertGreaterEqual(result["threshold"], .9)


if __name__ == "__main__":
    unittest.main()
