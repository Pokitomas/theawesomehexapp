import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('kimi_route_distill', HERE / 'kimi-route-distill.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class KimiRouteDistillTests(unittest.TestCase):
    def test_endpoint_normalization(self):
        self.assertEqual(MOD.endpoint('https://api.moonshot.ai/v1'), 'https://api.moonshot.ai/v1/chat/completions')
        self.assertEqual(MOD.endpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1/chat/completions')
        self.assertEqual(MOD.endpoint('http://x/v1/chat/completions'), 'http://x/v1/chat/completions')

    def test_frozen_reads_request_and_user_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pack.jsonl'
            rows = [
                {'request': 'Summarize the incident.'},
                {'messages': [{'role': 'assistant', 'content': 'ignore'}, {'role': 'user', 'content': 'Which option is safer?'}]},
            ]
            path.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
            values = MOD.frozen([str(path)])
            self.assertIn('summarize the incident', values)
            self.assertIn('which option is safer', values)

    def test_valid_rejects_inconsistent_compound_labels(self):
        candidate = {'route': 'compound', 'authority': 'allow', 'context': 'ready', 'active_clauses': 1, 'compound': True}
        self.assertFalse(MOD.valid(candidate))
        candidate['active_clauses'] = 2
        self.assertTrue(MOD.valid(candidate))

    def test_near_copy_is_rejected(self):
        source = {'route': 'summary', 'prompt': 'Summarize the security review in three bullets'}
        candidate = {
            'source_id': 0, 'route': 'summary', 'prompt': 'Summarize the security review in exactly three bullets',
            'authority': 'allow', 'context': 'ready', 'active_clauses': 1, 'compound': False,
        }
        self.assertEqual(MOD.reject(candidate, source, set(), set(), .70), 'near-copy')


if __name__ == '__main__':
    unittest.main()
