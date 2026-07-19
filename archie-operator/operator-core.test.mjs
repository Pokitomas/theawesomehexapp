import test from 'node:test';
import assert from 'node:assert/strict';
import { composeResponse, featureStrings, formatConfidence, routeLabel, tokenize } from './operator-core.mjs';

const inference = route => ({ route, confidence: 0.91, protocol: ['OBSERVE', 'DRAFT', 'STOP'] });

test('tokenization is stable and normalized', () => {
  assert.deepEqual(tokenize('Plan—THE launch!'), ['plan', 'the', 'launch']);
  assert.ok(featureStrings('plan launch', true).includes('b:plan_launch'));
  assert.ok(featureStrings('plan', true).includes('c:^pl'));
});

test('each route produces a complete local response', () => {
  const routes = ['checklist', 'clarify', 'compound', 'decision', 'errands', 'event', 'message', 'next_action', 'objective', 'plan', 'study', 'summary'];
  for (const route of routes) {
    const result = composeResponse('Plan the launch and tell Maya that Friday works', inference(route));
    assert.equal(result.route, route);
    assert.ok(result.title.length > 3);
    assert.ok(result.lead.length > 5);
    assert.ok(result.sections.length > 0);
    assert.ok(result.plainText.includes(result.title));
  }
});

test('clarify route refuses to invent missing context', () => {
  const result = composeResponse('Handle it', inference('clarify'));
  assert.match(result.lead, /what exact result/i);
  assert.match(result.plainText, /without inventing context/i);
});

test('message route creates sendable text without fake details', () => {
  const result = composeResponse('Message Maya that Friday afternoon works', inference('message'));
  assert.match(result.lead, /^Hi Maya,/);
  assert.match(result.lead, /Friday afternoon works/i);
});

test('decision route extracts two options', () => {
  const result = composeResponse('Choose between repairing the laptop and replacing it', inference('decision'));
  assert.ok(result.sections.some(section => /repairing the laptop/i.test(section.heading)));
  assert.ok(result.sections.some(section => /replacing it/i.test(section.heading)));
});

test('format helpers are deterministic', () => {
  assert.equal(routeLabel('next_action'), 'next action');
  assert.equal(formatConfidence(0.934), '93%');
  assert.equal(formatConfidence(4), '100%');
});
