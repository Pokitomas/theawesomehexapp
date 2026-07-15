import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrankenstate } from '../verify-frankenstate.mjs';

const valid = `version: 35
repository: Pokitomas/theawesomehexapp
canonical_branch: assembly/recursive-weave-cognition
canonical_pr: 188
observed_head_before_ledger: 4339baecaa44f8811f0fa2377fc7ebe6e9d248de
state: implementation_complete_pending_exact_head_receipt
owner: GPT-5.6 Thinking
heartbeat:
  live_owner_receipt_found: false
sprawl_consolidation:
  single_ledger: .frankenstate
  duplicate_implementation_branches_created: 0
  duplicate_pull_requests_created: 0
  merge_performed: false
verification:
  witness_substitution_allowed: false
invariants:
  - No model, comment, or MATCHED receipt grants merge authority.
`;

test('accepts one current root ledger anchored to an ancestor', () => {
  const result = validateFrankenstate({
    text: valid,
    trackedPaths: ['.frankenstate', 'README.md'],
    isAncestor: sha => sha === '4339baecaa44f8811f0fa2377fc7ebe6e9d248de'
  });
  assert.equal(result.version, 35);
  assert.equal(result.canonical_pr, 188);
  assert.equal(result.tracked_ledger, '.frankenstate');
});

test('rejects duplicate ledgers', () => {
  assert.throws(() => validateFrankenstate({
    text: valid,
    trackedPaths: ['.frankenstate', 'nested/.frankenstate'],
    isAncestor: () => true
  }), /exactly one root \.frankenstate/);
});

test('rejects stale generation schema and historical owner takeover', () => {
  const stale = valid
    .replace('version: 35', 'version: 34')
    .replace('owner: GPT-5.6 Thinking', 'owner: heartbeat-audit (claude-sonnet-5, external co-engineer session)');
  assert.throws(() => validateFrankenstate({
    text: stale,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => true
  }), /version must be an integer >= 35/);
});

test('rejects a ledger anchored to an unrelated head', () => {
  assert.throws(() => validateFrankenstate({
    text: valid,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => false
  }), /is not an ancestor/);
});

test('rejects witness substitution or merge-authority broadening', () => {
  const weakened = valid
    .replace('witness_substitution_allowed: false', 'witness_substitution_allowed: true')
    .replace('No model, comment, or MATCHED receipt grants merge authority.', 'MATCHED grants merge authority.');
  assert.throws(() => validateFrankenstate({
    text: weakened,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => true
  }), /witness substitution denial is required/);
});
