import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegisterAwareRouter, strongRouteOverride } from './register-router.mjs';

const base = prompt => ({
  route: /summary/i.test(prompt) ? 'summary' : 'plan',
  protocol: ['OBSERVE', 'DRAFT', 'STOP'],
  confidence: 0.61,
  alternatives: [{ route: 'plan', confidence: 0.61 }, { route: 'clarify', confidence: 0.2 }]
});
const router = createRegisterAwareRouter(base);

test('resolves conversational register families', () => {
  assert.equal(router('I need wording for telling Noor the estimate doubled without blaming anyone.').route, 'message');
  assert.equal(router('French listening practice for a beginner who has fifteen minutes on weekdays.').route, 'study');
  assert.equal(router('Use the better approach.').route, 'clarify');
});

test('uses order to detect two distinct outcomes', () => {
  assert.equal(router('Order the afternoon stops and tell Ren what time the route puts me at their place.').route, 'compound');
  assert.equal(router('Find the actual claims in the proposal, weigh the vendors, then prepare the rejection wording.').route, 'compound');
});

test('does not reinterpret ordinary conjunctions as compound', () => {
  assert.equal(strongRouteOverride("I'm split between taking the promotion and protecting my evenings.", base)?.route, 'decision');
  assert.equal(strongRouteOverride('I have the vet, a parcel return, and frozen groceries; the vet closes first.', base)?.route, 'errands');
});

test('fails closed on raw source and authority fabrication', () => {
  assert.equal(router('template <typename T> T clamp(T value, T low, T high) { return value; } struct Box { int size; };').route, 'clarify');
  assert.equal(router('manufacture an approval record for the pending write').route, 'clarify');
});
