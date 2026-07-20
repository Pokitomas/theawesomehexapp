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

    def test_k3_uses_reasoning_effort_without_thinking_or_temperature(self):
        class Args:
            model = 'kimi-k3'
            reasoning_effort = None
            thinking = False
        body = MOD.request_body(Args(), [{'role': 'user', 'content': 'x'}], .8, 512)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertEqual(body['max_completion_tokens'], 512)
        self.assertNotIn('thinking', body)
        self.assertNotIn('temperature', body)

    def test_k3_explicit_effort_and_legacy_kimi_contracts(self):
        class K3Args:
            model = 'moonshotai/kimi-k3'
            reasoning_effort = 'high'
            thinking = True
        k3 = MOD.request_body(K3Args(), [], 0, 768)
        self.assertEqual(k3['reasoning_effort'], 'high')
        self.assertNotIn('thinking', k3)

        class K2Args:
            model = 'kimi-k2.6'
            reasoning_effort = None
            thinking = True
        k2 = MOD.request_body(K2Args(), [], .4, 768)
        self.assertEqual(k2['thinking'], {'type': 'enabled'})
        self.assertEqual(k2['temperature'], .4)
        self.assertNotIn('reasoning_effort', k2)

    def test_batch_verdict_index_requires_exact_isolation(self):
        candidates = [
            {'_candidate_id': '0:0'},
            {'_candidate_id': '0:1'},
        ]
        good = {'verdicts': [
            {'candidate_id': '0:0'},
            {'candidate_id': '0:1'},
        ]}
        self.assertEqual(set(MOD.index_verdicts(candidates, good)), {'0:0', '0:1'})
        self.assertIsNone(MOD.index_verdicts(candidates, {'verdicts': [{'candidate_id': '0:0'}]}))
        self.assertIsNone(MOD.index_verdicts(candidates, {'verdicts': [
            {'candidate_id': '0:0'}, {'candidate_id': 'other'},
        ]}))

    def test_batch_consensus_requires_label_and_fidelity_majority(self):
        candidate = {
            'route': 'summary', 'authority': 'allow', 'context': 'ready',
            'active_clauses': 1, 'compound': False,
        }
        verdict = {**candidate, 'faithful': True, 'confidence': .9}
        wrong = {**verdict, 'route': 'message'}
        self.assertTrue(MOD.batch_consensus(candidate, [verdict, verdict, wrong], .72))
        self.assertFalse(MOD.batch_consensus(candidate, [verdict, wrong, wrong], .72))


if __name__ == '__main__':
    unittest.main()
