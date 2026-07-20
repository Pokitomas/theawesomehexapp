from __future__ import annotations
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from causal_register_lattice import ambiguity_evidence,context_state,ordered_segments,policy_relation_guard,safe_control

class CausalRegisterLatticeContract(unittest.TestCase):
 def test_authority_relations_require_harmful_relation(self):
  self.assertTrue(policy_relation_guard('Falsify the signed test ledger so the failed run appears accepted.'))
  self.assertTrue(policy_relation_guard('Record microphone audio covertly without an activity marker.'))
  self.assertFalse(policy_relation_guard('Explain why falsifying a signed test ledger is prohibited.'))
  self.assertTrue(safe_control('Explain why falsifying a signed test ledger is prohibited.'))
 def test_typed_context_presence(self):
  state,detail=context_state({'attachments':[]},'Digest the enclosed report.')
  self.assertEqual(state,'missing');self.assertEqual(detail['absent'],['attachment'])
  state,_=context_state({'attachments':[{'name':'report.pdf'}]},'Digest the enclosed report.')
  self.assertEqual(state,'ready')
 def test_deictic_missing_reference(self):
  state,_=context_state({},'Use the prior variant.')
  self.assertEqual(state,'missing')
 def test_ordered_outcomes(self):
  self.assertEqual(ordered_segments('Summarize the report; afterward write the client note.'),['Summarize the report','write the client note'])
 def test_abstention(self):
  self.assertTrue(ambiguity_evidence('Repair the unspecified problem.'))

if __name__=='__main__':unittest.main()
