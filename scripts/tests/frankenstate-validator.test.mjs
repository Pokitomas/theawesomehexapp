import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrankenstate } from '../verify-frankenstate.mjs';

const valid = `version: 38
repository: Pokitomas/theawesomehexapp
canonical_branch: main
canonical_pr: 212
observed_head_before_ledger: 4339baecaa44f8811f0fa2377fc7ebe6e9d248de
state: complete
owner: GPT-5.6 Thinking
heartbeat:
  live_owner_receipt_found: true
terminal_surface:
  corrective_merge_commit: a5c4c5d663a8bec5c6698e1da4df366abca8b433
sprawl_consolidation:
  single_ledger: .frankenstate
  duplicate_implementation_branches_created: 0
  duplicate_pull_requests_created: 0
  merge_performed: true
  historical_merge_pr: 188
  historical_merge_commit: d0b628b9800a986f87f153378846ddce224a4058
  merged_against_terminal_decision: HOLD
verification:
  witness_substitution_allowed: false
invariants:
  - No model, comment, or MATCHED receipt grants merge authority.
`;

const revival = valid
  .replace('version: 38', 'version: 39')
  .replace('canonical_branch: main', 'canonical_branch: revival/repository-wide-generation')
  .replace('canonical_pr: 212', 'canonical_pr: 233')
  .replace('state: complete', 'state: revival_active_pending_exact_head_receipts')
  .replace('owner: GPT-5.6 Thinking', 'owner: GPT-5.6 Thinking repository-wide revival generation');

test('accepts one terminal main ledger anchored to an ancestor', () => {
  const result = validateFrankenstate({
    text: valid,
    trackedPaths: ['.frankenstate', 'README.md'],
    isAncestor: sha => sha === '4339baecaa44f8811f0fa2377fc7ebe6e9d248de'
  });
  assert.equal(result.version, 38);
  assert.equal(result.canonical_branch, 'main');
  assert.equal(result.canonical_pr, 212);
  assert.equal(result.corrective_merge_commit, 'a5c4c5d663a8bec5c6698e1da4df366abca8b433');
  assert.equal(result.merge_performed, true);
  assert.equal(result.live_owner_receipt_found, true);
  assert.equal(result.tracked_ledger, '.frankenstate');
});

test('accepts an active repository-wide revival on a non-main vehicle', () => {
  const result = validateFrankenstate({
    text: revival,
    trackedPaths: ['.frankenstate', 'REVIVAL.md'],
    isAncestor: sha => sha === '4339baecaa44f8811f0fa2377fc7ebe6e9d248de'
  });
  assert.equal(result.version, 39);
  assert.equal(result.canonical_branch, 'revival/repository-wide-generation');
  assert.equal(result.canonical_pr, 233);
  assert.equal(result.state, 'revival_active_pending_exact_head_receipts');
  assert.equal(result.merge_performed, true);
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
    .replace('version: 38', 'version: 34')
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

test('rejects a recorded merge without exact historical evidence', () => {
  const missing = valid
    .replace('historical_merge_commit: d0b628b9800a986f87f153378846ddce224a4058', 'historical_merge_commit: unknown')
    .replace('merged_against_terminal_decision: HOLD', 'merged_against_terminal_decision: MERGE RECOMMENDED');
  assert.throws(() => validateFrankenstate({
    text: missing,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => true
  }), /historical_merge_commit must record the exact merged SHA/);
});

test('rejects main as an active vehicle or a nonnumeric PR', () => {
  const invalid = valid
    .replace('state: complete', 'state: corrective_active_pending_terminal_audit')
    .replace('canonical_pr: 212', 'canonical_pr: none');
  assert.throws(() => validateFrankenstate({
    text: invalid,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => true
  }), /active ledger must identify a non-main canonical branch/);
});

test('rejects a complete ledger without the exact corrective merge', () => {
  const missing = valid.replace(
    'corrective_merge_commit: a5c4c5d663a8bec5c6698e1da4df366abca8b433',
    'corrective_merge_commit: pending'
  );
  assert.throws(() => validateFrankenstate({
    text: missing,
    trackedPaths: ['.frankenstate'],
    isAncestor: () => true
  }), /complete ledger must record the exact corrective_merge_commit/);
});
