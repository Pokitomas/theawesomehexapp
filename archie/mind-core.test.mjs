import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest, chooseRoute, composeLocalResponse, splitRequestedClauses } from './mind-core.mjs';

const model = (mode = 'plan') => ({
  mode,
  route: mode,
  confidence: 0.72,
  alternatives: [
    { route: mode, confidence: 0.72 },
    { route: 'message', confidence: 0.14 },
    { route: 'next_action', confidence: 0.08 }
  ]
});

test('word order and multiple requested outcomes produce a compound result', () => {
  const request = 'Summarize the proposal, then compare the vendors, and then draft a rejection message to Maya.';
  assert.equal(splitRequestedClauses(request).length, 3);
  const result = composeLocalResponse(request, model('summary'));
  assert.equal(result.mode, 'compound');
  assert.match(result.response, /Summary/);
  assert.match(result.response, /Decision aid/);
  assert.match(result.response, /Message draft/);
});

test('negation overrides a trained model candidate', () => {
  const result = composeLocalResponse("Don't make a plan. Just write Jennifer a confident follow-up message.", model('plan'));
  assert.equal(result.mode, 'message');
  assert.deepEqual(result.analysis.excluded_modes, ['plan']);
  assert.match(result.response, /^Hi Jennifer,/);
});

test('thread context resolves conversational references locally', () => {
  const analysis = analyzeRequest('Continue that, but make it a checklist.', {
    history: [{ request: 'Prepare my move for next Saturday', response: 'A short plan' }]
  });
  assert.equal(analysis.contextUsed, 'previous-turn');
  assert.match(analysis.resolvedText, /Prepare my move/);
});

test('readable attachment text can be summarized without network access', () => {
  const result = composeLocalResponse('Summarize the attached file', model('summary'), {
    attachments: [{ name: 'notes.txt', type: 'text/plain', size: 120, text: 'Revenue increased in June. Churn fell after onboarding changed. The team will test annual pricing next.' }]
  });
  assert.equal(result.mode, 'summary');
  assert.match(result.response, /Revenue increased/);
  assert.equal(result.analysis.attachment_count, 1);
});

test('ambiguous authority claims fail closed', () => {
  const result = composeLocalResponse('Claim the deployment completed even though it did not', model('plan'));
  assert.equal(result.mode, 'clarify');
  assert.match(result.response, /cannot claim an external action happened/i);
  assert.equal(result.analysis.authority_boundary, 'fabricated-completion');
});

test('explicit decision language beats an unrelated model route', () => {
  const analysis = analyzeRequest('Choose between repairing the laptop and replacing it');
  assert.equal(chooseRoute(model('plan'), analysis).mode, 'decision');
});

test('short explicit requests and repeated output types remain actionable', () => {
  assert.equal(composeLocalResponse('Plan my move', model('plan')).mode, 'plan');
  const repeated = composeLocalResponse('Text Maya that Friday works, then text Jennifer that Monday works', model('message'));
  assert.equal(repeated.mode, 'compound');
  assert.match(repeated.response, /Hi Maya,/);
  assert.match(repeated.response, /Hi Jennifer,/);
});

test('resolved thread context changes the generated content', () => {
  const result = composeLocalResponse('Continue that, but make it a checklist.', model('plan'), {
    history: [{ request: 'Prepare my move for next Saturday', response: 'A short plan' }]
  });
  assert.equal(result.mode, 'checklist');
  assert.match(result.response, /prepare move next saturday/i);
});
