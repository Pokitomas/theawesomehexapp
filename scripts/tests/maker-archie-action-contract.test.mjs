import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateActionContract,
  normalizeActionContract
} from '../archie-action-contract.mjs';

test('accepts alternate valid traces when optional setup differs from the reference', () => {
  const contract = {
    required_actions: ['git:repair_conflict', 'node:test'],
    optional_actions: ['git:status'],
    forbidden_actions: ['git:force_push'],
    ordering: [['git:repair_conflict', 'node:test']]
  };
  const withStatus = evaluateActionContract(['git:status', 'git:repair_conflict', 'node:test'], contract);
  const withoutStatus = evaluateActionContract(['git:repair_conflict', 'node:test'], contract);
  assert.equal(withStatus.satisfied, true);
  assert.equal(withoutStatus.satisfied, true);
  assert.deepEqual(withoutStatus.required_missing, []);
});

test('rejects missing requirements, forbidden actions, and causally invalid order', () => {
  const contract = {
    required_actions: ['git:repair_conflict', 'node:test'],
    optional_actions: ['git:status'],
    forbidden_actions: ['git:force_push'],
    ordering: [['git:repair_conflict', 'node:test']]
  };
  const missing = evaluateActionContract(['git:status', 'git:repair_conflict'], contract);
  assert.equal(missing.satisfied, false);
  assert.deepEqual(missing.required_missing, ['node:test']);

  const forbidden = evaluateActionContract(['git:repair_conflict', 'git:force_push', 'node:test'], contract);
  assert.equal(forbidden.satisfied, false);
  assert.deepEqual(forbidden.forbidden_observed, ['git:force_push']);

  const reordered = evaluateActionContract(['node:test', 'git:repair_conflict'], contract);
  assert.equal(reordered.satisfied, false);
  assert.deepEqual(reordered.ordering_violations, [{
    before: 'git:repair_conflict',
    after: 'node:test',
    before_index: 1,
    after_index: 0
  }]);
});

test('rejects undeclared extra actions unless the contract explicitly permits them', () => {
  const strict = evaluateActionContract(
    ['filesystem:write_contract', 'network:upload', 'json:validate_schema'],
    {
      required_actions: ['filesystem:write_contract', 'json:validate_schema'],
      ordering: [['filesystem:write_contract', 'json:validate_schema']]
    }
  );
  assert.equal(strict.satisfied, false);
  assert.deepEqual(strict.unlisted_observed, ['network:upload']);

  const extensible = evaluateActionContract(
    ['filesystem:write_contract', 'logging:record_receipt', 'json:validate_schema'],
    {
      required_actions: ['filesystem:write_contract', 'json:validate_schema'],
      ordering: [['filesystem:write_contract', 'json:validate_schema']],
      allow_unlisted_actions: true
    }
  );
  assert.equal(extensible.satisfied, true);
});

test('falls back to exact declared reference actions when no explicit contract is supplied', () => {
  const evaluation = evaluateActionContract(
    ['social:read_report', 'social:moderate'],
    {},
    { reference_actions: ['social:read_report', 'social:moderate'] }
  );
  assert.equal(evaluation.satisfied, true);
  assert.deepEqual(evaluation.contract.required_actions, ['social:read_report', 'social:moderate']);
  assert.equal(evaluation.contract.allow_unlisted_actions, false);
});

test('normalization rejects contradictory and malformed contracts', () => {
  assert.throws(() => normalizeActionContract({
    required_actions: ['git:status'],
    optional_actions: ['git:status']
  }), /conflicting/);
  assert.throws(() => normalizeActionContract({
    required_actions: ['git:repair_conflict'],
    ordering: [['git:repair_conflict', 'node:test']]
  }), /undeclared/);
  assert.throws(() => normalizeActionContract({
    required_actions: ['not-an-action']
  }), /tool:action/);
  assert.throws(() => normalizeActionContract({
    required_actions: ['git:status', 'git:status']
  }), /duplicates/);
});
