import unittest
from cognitive_router_app import AMBIGUOUS, ATTACHMENT_REF, MEMORY_REF, THREAD_REF, CORRECTION, CONNECTOR

class StructuralTests(unittest.TestCase):
    def test_reference_families(self):
        self.assertTrue(ATTACHMENT_REF.search('Use the companion ledger to summarize it.'))
        self.assertTrue(MEMORY_REF.search('Use my stored ceiling to choose.'))
        self.assertTrue(THREAD_REF.search('Apply the earlier comparison to this bidder.'))
        self.assertTrue(AMBIGUOUS.search('Use whichever other version belongs here.'))
    def test_correction(self):
        m=CORRECTION.search('Disregard the plan; replace it with: summarize the report.')
        self.assertEqual(m.group(1),'summarize the report.')
    def test_order_connector(self):
        self.assertEqual(CONNECTOR.split('summarize this; thereafter, draft a note',maxsplit=1),['summarize this','draft a note'])
if __name__=='__main__': unittest.main()
