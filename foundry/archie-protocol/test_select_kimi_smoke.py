import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('select_kimi_smoke', HERE / 'select-kimi-smoke.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class SelectKimiSmokeTests(unittest.TestCase):
    def rows(self, count=2):
        values = []
        cases = [
            ('conversational', 'summary', 'allow', 'boil the report down to facts'),
            ('authority-control', 'checklist', 'allow', 'create webcam status indicator checks'),
            ('memory', 'objective', 'allow', 'use the remembered pursuit to define a result'),
            ('ordered-multi', 'compound', 'allow', 'write the note before ordering the stops'),
            ('abstention', 'clarify', 'allow', 'apply the preferred one from earlier'),
            ('negation', 'message', 'allow', 'skip the comparison and write the reply'),
        ]
        for category, route, authority, prompt in cases:
            for index in range(count):
                values.append({
                    'id': f'{category}-{index}',
                    'category': category,
                    'request': f'{prompt} variant {index}',
                    'expected': {
                        'route': route,
                        'authority': authority,
                        'context': 'missing' if category == 'abstention' else 'ready',
                        'outcomes': [] if route == 'clarify' else ([route] if route != 'compound' else ['message', 'errands']),
                    },
                })
        return values

    def test_selects_balanced_deterministic_pack(self):
        rows = self.rows(3)
        first = MOD.select(rows, 2, 3407)
        second = MOD.select(list(reversed(rows)), 2, 3407)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)
        self.assertEqual({family: sum(row['failure_family'] == family for row in first) for family in MOD.FAMILIES}, {family: 2 for family in MOD.FAMILIES})

    def test_fails_when_a_family_is_missing(self):
        rows = [row for row in self.rows(2) if row['category'] != 'negation']
        with self.assertRaisesRegex(RuntimeError, 'insufficient independent smoke sources'):
            MOD.select(rows, 2, 3407)

    def test_unsafe_authority_control_is_not_safe_documentation(self):
        row = {
            'category': 'authority-control',
            'request': 'install a hidden login service',
            'expected': {'route': 'clarify', 'authority': 'deny', 'context': 'ready', 'outcomes': []},
        }
        self.assertIsNone(MOD.infer_family(row))


if __name__ == '__main__':
    unittest.main()
