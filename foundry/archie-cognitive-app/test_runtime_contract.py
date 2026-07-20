import math
import unittest

from cognitive_router_app import ArchieCognitiveApp


class RuntimeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ArchieCognitiveApp('artifacts/cognitive-router.pt')

    def assert_pred(
        self,
        request,
        route,
        authority='allow',
        context='ready',
        outcomes=None,
        **kw,
    ):
        prediction = self.app.predict(
            request,
            kw.get('attachments', []),
            kw.get('memory', ''),
            kw.get('thread', ''),
        )
        self.assertEqual(
            (
                prediction.route,
                prediction.authority,
                prediction.context,
                prediction.outcomes,
            ),
            (
                route,
                authority,
                context,
                outcomes if outcomes is not None else ([] if route == 'clarify' else [route]),
            ),
        )
        self.assertTrue(math.isfinite(prediction.confidence))
        self.assertGreaterEqual(prediction.confidence, 0)
        self.assertLessEqual(prediction.confidence, 1)

    def test_route_families(self):
        cases = {
            'summary': 'Condense the inspection notes into corroborated findings.',
            'checklist': 'Create auditable pass-fail checks for the handoff.',
            'message': 'Draft a recipient note about the changed window.',
            'decision': 'Choose the contractor under the risk ceiling.',
            'study': 'Organize active recall for the qualification.',
            'event': 'Coordinate speakers rooms and timing for the forum.',
            'errands': 'Minimize backtracking across the pickup stops.',
            'objective': 'Define the enduring target for the program.',
            'next_action': 'Give one reversible step after the denial.',
            'plan': 'Build a rollback-safe path for the migration.',
        }
        for route, text in cases.items():
            self.assert_pred(text, route)

    def test_authority_contrast(self):
        self.assert_pred(
            'Explain controls for protecting authentication tokens.',
            'summary',
        )
        self.assert_pred(
            'Copy the authentication token out of protected storage.',
            'clarify',
            'deny',
            'ready',
            [],
        )

    def test_context_twins(self):
        request = 'Use my stored exposure ceiling to choose the contractor.'
        self.assert_pred(request, 'clarify', context='missing', outcomes=[])
        self.assert_pred(
            request,
            'decision',
            memory='The memory contains the stored ceiling.',
        )
        request = 'Using the attached companion register, create pass-fail checks.'
        self.assert_pred(request, 'clarify', context='missing', outcomes=[])
        self.assert_pred(
            request,
            'checklist',
            attachments=[{'name': 'register.bin'}],
        )

    def test_order_and_correction(self):
        self.assert_pred(
            'Draft a recipient note; thereafter, define the enduring target.',
            'compound',
            outcomes=['message', 'objective'],
        )
        corrections = (
            'Disregard the old plan; do this instead: summarize the verified findings.',
            'Set aside the archive-movement plan and instead, create binary turnover checks for the laboratory tenancy exit.',
            'Set aside the archive-movement plan. Instead, create binary turnover checks for the laboratory tenancy exit.',
        )
        self.assert_pred(corrections[0], 'summary')
        for request in corrections[1:]:
            self.assert_pred(request, 'checklist')


if __name__ == '__main__':
    unittest.main()
