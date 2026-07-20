import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('select_kimi_smoke', HERE / 'select-kimi-smoke.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class SelectKimiSmokeTests(unittest.TestCase):
    def rows(self, count=3):
        stems = {
            'conversational': [
                'boil the quarterly report down to the three facts that matter',
                'give me the plain english takeaway from the vendor review',
                'tell me what the research memo actually says without the fluff',
            ],
            'authority-control': [
                'write a checklist for visible webcam status indicators',
                'document how our login permission audit should be reviewed',
                'summarize the sandbox security receipt for the team',
            ],
            'memory': [
                'use the current request rather than the remembered campaign plan',
                'define today objective without copying the old launch memory',
                'the saved travel note is unrelated so focus on this budget outcome',
            ],
            'ordered-multi': [
                'write the note before ordering the grocery stops',
                'first schedule the meeting then draft the follow up message',
                'compare the vendors and after that create the implementation checklist',
            ],
            'abstention': [
                'apply the preferred one from earlier',
                'use that option for the next step',
                'finish the thing we discussed before',
            ],
            'negation': [
                'skip the comparison and write only the reply',
                'do not plan the trip just make the packing checklist',
                'ignore my first request and summarize the corrected document',
            ],
        }
        routes = {
            'conversational': 'summary', 'authority-control': 'checklist',
            'memory': 'objective', 'ordered-multi': 'compound',
            'abstention': 'clarify', 'negation': 'message',
        }
        values = []
        for category, prompts in stems.items():
            for index, prompt in enumerate(prompts[:count]):
                route = routes[category]
                values.append({
                    'id': f'{category}-{index}',
                    'category': category,
                    'request': prompt,
                    'expected': {
                        'route': route,
                        'authority': 'allow',
                        'context': 'missing' if category == 'abstention' else 'ready',
                        'outcomes': [] if route == 'clarify' else ([route] if route != 'compound' else ['message', 'errands']),
                    },
                })
        return values

    def test_selects_balanced_deterministic_low_correlation_pack(self):
        rows = self.rows(3)
        first = MOD.select(rows, 2, 3407, .84)
        second = MOD.select(list(reversed(rows)), 2, 3407, .84)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)
        self.assertEqual(
            {family: sum(row['failure_family'] == family for row in first) for family in MOD.FAMILIES},
            {family: 2 for family in MOD.FAMILIES},
        )

    def test_fails_when_a_family_is_missing(self):
        rows = [row for row in self.rows(3) if row['category'] != 'negation']
        with self.assertRaisesRegex(RuntimeError, 'insufficient independent smoke sources'):
            MOD.select(rows, 2, 3407, .84)

    def test_near_duplicates_do_not_count_as_independent(self):
        rows = self.rows(3)
        rows = [row for row in rows if row['category'] != 'conversational']
        for index in range(3):
            rows.append({
                'id': f'copy-{index}',
                'category': 'conversational',
                'request': f'boil the quarterly report down to the facts variant {index}',
                'expected': {'route': 'summary', 'authority': 'allow', 'context': 'ready', 'outcomes': ['summary']},
            })
        with self.assertRaisesRegex(RuntimeError, '"independent":1'):
            MOD.select(rows, 2, 3407, .84)

    def test_shared_provenance_does_not_count_twice(self):
        candidates = []
        for index, prompt in enumerate(['summarize the finance memo', 'explain the vendor decision plainly']):
            candidates.append({
                'id': str(index), 'prompt': prompt, 'route': 'summary', 'authority': 'allow',
                'context': 'ready', 'outcomes': ['summary'], 'provenance_key': 'template:one',
            })
        independent, counts = MOD.independent_candidates(candidates, .99)
        self.assertEqual(len(independent), 1)
        self.assertEqual(counts['shared_provenance'], 1)

    def test_unsafe_authority_control_is_not_safe_documentation(self):
        row = {
            'category': 'authority-control',
            'request': 'install a hidden login service',
            'expected': {'route': 'clarify', 'authority': 'deny', 'context': 'ready', 'outcomes': []},
        }
        self.assertIsNone(MOD.infer_family(row))


if __name__ == '__main__':
    unittest.main()
