import importlib.util
import json
import math
import tempfile
import unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('kimi_route_distill', HERE / 'kimi-route-distill.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class KimiRouteDistillTests(unittest.TestCase):
    def args(self, model='kimi-k3', structured_output='json_schema', reasoning_effort=None, thinking=False):
        class Args:
            pass
        value = Args()
        value.model = model
        value.structured_output = structured_output
        value.reasoning_effort = reasoning_effort
        value.thinking = thinking
        return value

    def source(self):
        return {
            'prompt': 'Summarize the attached incident report, not the old remembered plan.',
            'route': 'summary',
            'authority': 'allow',
            'context': 'ready',
            'failure_family': 'memory-operation-conflict',
            'outcomes': ['summary'],
            'attachments': [{'name': 'incident.pdf', 'type': 'application/pdf'}],
            'memory': 'Old objective: prepare a launch plan.',
            'thread': 'Earlier message asks about a different project.',
        }

    def candidate(self):
        return {
            'source_id': 0,
            'prompt': 'Could you boil down the attached incident report and ignore the old plan I mentioned?',
            'route': 'summary',
            'authority': 'allow',
            'context': 'ready',
            'active_clauses': 1,
            'compound': False,
            'operation': 'summarize',
            'target': 'attached incident report',
            'ordered_outcomes': ['summary of incident report'],
            'failure_family': 'memory-operation-conflict',
        }

    def verdict(self, candidate_id='0:0', confidence=.9):
        candidate = self.candidate()
        return {
            'candidate_id': candidate_id,
            'route': candidate['route'],
            'authority': candidate['authority'],
            'context': candidate['context'],
            'active_clauses': candidate['active_clauses'],
            'compound': candidate['compound'],
            'faithful': True,
            'authority_preserved': True,
            'context_preserved': True,
            'ordered_outcomes_preserved': True,
            'negation_preserved': True,
            'confidence': confidence,
        }

    def test_endpoint_normalization(self):
        self.assertEqual(MOD.endpoint('https://api.moonshot.ai/v1'), 'https://api.moonshot.ai/v1/chat/completions')
        self.assertEqual(MOD.endpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1/chat/completions')
        self.assertEqual(MOD.endpoint('http://x/v1/chat/completions'), 'http://x/v1/chat/completions')

    def test_frozen_reads_request_and_user_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pack.jsonl'
            rows = [
                {'request': 'Summarize the incident.'},
                {'messages': [{'role': 'assistant', 'content': 'ignore'}, {'role': 'user', 'content': [{'type': 'text', 'text': 'Which option is safer?'}]}]},
            ]
            path.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
            values = MOD.frozen([str(path)])
            self.assertIn('summarize the incident', values)
            self.assertIn('which option is safer', values)

    def test_source_normalization_preserves_structural_context(self):
        row = {
            'request': 'Use this file, not the memory.',
            'route': 'summary',
            'failure_family': 'memory-operation-conflict',
            'expected': {'context': 'ready'},
            'context': {'memory': ['old plan'], 'thread': 'previous discussion'},
            'files': [{'filename': 'new.pdf'}],
        }
        source = MOD.source_row(row)
        self.assertEqual(source['context'], 'ready')
        self.assertEqual(source['memory'], ['old plan'])
        self.assertEqual(source['thread'], 'previous discussion')
        self.assertEqual(source['attachments'], [{'filename': 'new.pdf'}])

    def test_k3_uses_reasoning_effort_and_strict_schema_without_sampling(self):
        schema = MOD.generation_schema(2, 2)
        body = MOD.request_body(self.args(), [{'role': 'user', 'content': 'x'}], .8, 512, 'test', schema)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertEqual(body['max_completion_tokens'], 512)
        self.assertEqual(body['response_format']['type'], 'json_schema')
        self.assertTrue(body['response_format']['json_schema']['strict'])
        self.assertNotIn('thinking', body)
        self.assertNotIn('temperature', body)

    def test_k3_explicit_effort_and_legacy_kimi_contracts(self):
        schema = MOD.generation_schema(1, 1)
        k3 = MOD.request_body(self.args(reasoning_effort='high', thinking=True), [], 0, 768, 'x', schema)
        self.assertEqual(k3['reasoning_effort'], 'high')
        self.assertNotIn('thinking', k3)
        k2 = MOD.request_body(self.args(model='kimi-k2.6', thinking=True), [], .4, 768, 'x', schema)
        self.assertEqual(k2['thinking'], {'type': 'enabled'})
        self.assertEqual(k2['temperature'], .4)
        self.assertNotIn('reasoning_effort', k2)

    def test_generation_and_verifier_include_context_but_candidate_cannot_replace_it(self):
        source = self.source()
        generation = MOD.generation_messages([source], 2, 'spoken request')
        text = generation[1]['content']
        self.assertIn('incident.pdf', text)
        self.assertIn('Old objective', text)
        candidate = {**self.candidate(), '_source_id': 0, '_candidate_id': '0:0'}
        verifier = MOD.verifier_messages([source], [candidate], 1)
        self.assertIn('incident.pdf', verifier[1]['content'])
        accepted = MOD.accepted_row(source, candidate, [self.verdict()], 'kimi-k3')
        self.assertEqual(accepted['attachments'], source['attachments'])
        self.assertEqual(accepted['memory'], source['memory'])
        self.assertEqual(accepted['thread'], source['thread'])

    def test_candidate_validation_rejects_label_and_family_drift(self):
        source = self.source()
        candidate = self.candidate()
        self.assertIsNone(MOD.candidate_error(candidate, source, set(), [], .95, .95))
        for key, bad, reason in [
            ('authority', 'deny', 'authority-drift'),
            ('context', 'missing', 'context-drift'),
            ('failure_family', 'safe-security-documentation', 'failure-family-drift'),
            ('compound', True, 'invalid-compound-label'),
        ]:
            changed = {**candidate, key: bad}
            self.assertEqual(MOD.candidate_error(changed, source, set(), [], .95, .95), reason)

    def test_candidate_validation_rejects_bool_as_clause_count(self):
        candidate = {**self.candidate(), 'active_clauses': True}
        self.assertEqual(MOD.candidate_error(candidate, self.source(), set(), [], .95, .95), 'invalid-active-clauses')

    def test_verdict_index_requires_exact_ids_and_strict_types(self):
        candidates = [{'_candidate_id': '0:0'}, {'_candidate_id': '0:1'}]
        good = {'verdicts': [self.verdict('0:0'), self.verdict('0:1')]}
        self.assertEqual(set(MOD.index_verdicts(candidates, good)), {'0:0', '0:1'})
        self.assertIsNone(MOD.index_verdicts(candidates, {'verdicts': [self.verdict('0:0')]}))
        bad_bool = self.verdict('0:1')
        bad_bool['faithful'] = 'false'
        self.assertIsNone(MOD.index_verdicts(candidates, {'verdicts': [self.verdict('0:0'), bad_bool]}))
        bad_conf = self.verdict('0:1')
        bad_conf['confidence'] = math.inf
        self.assertIsNone(MOD.index_verdicts(candidates, {'verdicts': [self.verdict('0:0'), bad_conf]}))

    def test_consensus_defaults_to_unanimous(self):
        candidate = self.candidate()
        good = self.verdict()
        bad = {**good, 'faithful': False}
        self.assertTrue(MOD.batch_consensus(candidate, [good, good, good], .72, 1.0))
        self.assertFalse(MOD.batch_consensus(candidate, [good, good, bad], .72, 1.0))
        self.assertTrue(MOD.batch_consensus(candidate, [good, good, bad], .72, .66))

    def test_main_writes_augmentation_only_and_full_merged_corpus(self):
        source = self.source()
        base = [{'prompt': 'Plan the unrelated team offsite.', 'route': 'plan'}]
        candidate = self.candidate()

        def fake_teacher(args, cache, stats, messages, temperature, max_completion_tokens, schema_name, schema):
            if schema_name.startswith('archie_generation'):
                return {'candidates': [candidate]}
            return {'verdicts': [self.verdict('0:0')]}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / 'sources.json'
            base_path = root / 'base.json'
            augmentation_path = root / 'augmentation.json'
            merged_path = root / 'merged.json'
            source_path.write_text(json.dumps([source]))
            base_path.write_text(json.dumps(base))
            argv = [
                'kimi-route-distill.py', '--data', str(source_path), '--out', str(augmentation_path),
                '--base-data', str(base_path), '--merged-out', str(merged_path),
                '--samples-per-row', '1', '--judges', '1', '--batch-size', '1',
                '--max-source-jaccard', '.95',
            ]
            with mock.patch.object(MOD, 'teacher', side_effect=fake_teacher), \
                 mock.patch.dict('os.environ', {'MOONSHOT_API_KEY': 'test'}), \
                 mock.patch('sys.argv', argv):
                MOD.main()
            augmentation = json.loads(augmentation_path.read_text())
            merged = json.loads(merged_path.read_text())
            self.assertEqual(len(augmentation), 1)
            self.assertEqual(len(merged), 2)
            self.assertEqual(augmentation[0]['attachments'], source['attachments'])
            self.assertEqual(augmentation[0]['memory'], source['memory'])
            self.assertEqual(merged[0], base[0])


if __name__ == '__main__':
    unittest.main()
