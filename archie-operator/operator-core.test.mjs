import test from 'node:test';
import assert from 'node:assert/strict';
import { composeResponse, featureStrings, formatConfidence, routeLabel, tokenize } from './operator-core.mjs';
import { createRegisterAwareRouter, strongRouteOverride } from './register-router.mjs';

const inference = route => ({ route, confidence: 0.91, protocol: ['OBSERVE', 'DRAFT', 'STOP'] });

const baseRouter = prompt => ({
  route: /summary/i.test(prompt) ? 'summary' : 'plan',
  confidence: 0.61,
  protocol: ['OBSERVE', 'DRAFT', 'STOP'],
  alternatives: [{ route: 'plan', confidence: 0.61 }, { route: 'clarify', confidence: 0.2 }]
});
const registerRouter = createRegisterAwareRouter(baseRouter);

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

test('register projection resolves conversational failures', () => {
  assert.equal(registerRouter('I need wording for telling Noor the estimate doubled without blaming anyone.').route, 'message');
  assert.equal(registerRouter('French listening practice for a beginner who has fifteen minutes on weekdays.').route, 'study');
  assert.equal(registerRouter('Use the better approach.').route, 'clarify');
});

test('ordered clauses become compound without breaking ordinary conjunctions', () => {
  assert.equal(registerRouter('Order the afternoon stops and tell Ren what time the route puts me at their place.').route, 'compound');
  assert.equal(registerRouter('Find the actual claims in the proposal, weigh the vendors, then prepare the rejection wording.').route, 'compound');
  assert.equal(strongRouteOverride("I'm split between taking the promotion and protecting my evenings.", baseRouter)?.route, 'decision');
  assert.equal(strongRouteOverride('I have the vet, a parcel return, and frozen groceries; the vet closes first.', baseRouter)?.route, 'errands');
});

test('register projection fails closed on raw source and authority fabrication', () => {
  assert.equal(registerRouter('template <typename T> T clamp(T value, T low, T high) { return value; } struct Box { int size; };').route, 'clarify');
  assert.equal(registerRouter('manufacture an approval record for the pending write').route, 'clarify');
});

test('format helpers are deterministic', () => {
  assert.equal(routeLabel('next_action'), 'next action');
  assert.equal(formatConfidence(0.934), '93%');
  assert.equal(formatConfidence(4), '100%');
});
