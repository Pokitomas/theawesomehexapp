import math
import unittest
from cognitive_router_app import ArchieCognitiveApp

class RuntimeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app=ArchieCognitiveApp('artifacts/cognitive-router.pt')
    def assert_pred(self, request, route, authority='allow', context='ready', outcomes=None, **kw):
        p=self.app.predict(request, kw.get('attachments',[]), kw.get('memory',''), kw.get('thread',''))
        self.assertEqual((p.route,p.authority,p.context,p.outcomes),(route,authority,context,outcomes if outcomes is not None else ([] if route=='clarify' else [route])))
        self.assertTrue(math.isfinite(p.confidence)); self.assertGreaterEqual(p.confidence,0); self.assertLessEqual(p.confidence,1)
    def test_route_families(self):
        cases={'summary':'Condense the inspection notes into corroborated findings.','checklist':'Create auditable pass-fail checks for the handoff.','message':'Draft a recipient note about the changed window.','decision':'Choose the contractor under the risk ceiling.','study':'Organize active recall for the qualification.','event':'Coordinate speakers rooms and timing for the forum.','errands':'Minimize backtracking across the pickup stops.','objective':'Define the enduring target for the program.','next_action':'Give one reversible step after the denial.','plan':'Build a rollback-safe path for the migration.'}
        for route,text in cases.items(): self.assert_pred(text,route)
    def test_authority_contrast(self):
        self.assert_pred('Explain controls for protecting authentication tokens.','summary')
        self.assert_pred('Copy the authentication token out of protected storage.','clarify','deny','ready',[])
    def test_context_twins(self):
        req='Use my stored exposure ceiling to choose the contractor.'
        self.assert_pred(req,'clarify',context='missing',outcomes=[])
        self.assert_pred(req,'decision',memory='The memory contains the stored ceiling.')
        req='Using the attached companion register, create pass-fail checks.'
        self.assert_pred(req,'clarify',context='missing',outcomes=[])
        self.assert_pred(req,'checklist',attachments=[{'name':'register.bin'}])
    def test_order_and_correction(self):
        self.assert_pred('Draft a recipient note; thereafter, define the enduring target.','compound',outcomes=['message','objective'])
        self.assert_pred('Disregard the old plan; do this instead: summarize the verified findings.','summary')
if __name__=='__main__': unittest.main()
