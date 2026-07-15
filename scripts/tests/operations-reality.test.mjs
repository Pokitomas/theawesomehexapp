import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildProbeReceipt, probePublicEndpoint, validateSnapshot } from '../operations-probe.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/operations-reality.json'));
const runbook = await read('OPERATIONS_RUNBOOK.md');
const SHA = 'a'.repeat(40);
const OBSERVED = '2026-07-15T18:00:00.000Z';
const NOW = Date.parse('2026-07-15T19:00:00.000Z');
const evidence = source => [{ source, observed_at: OBSERVED, digest: 'sha256:redacted-fixture' }];
const procedure = authority => ({ authority, commands: ['verify exact candidate'], rollback: ['revert exact admitted commit'], stop_conditions: ['commit mismatch'] });

function snapshot(overrides = {}) {
  return {
    schema: 'sideways-operations-snapshot/v1',
    observed_at: OBSERVED,
    authorized_commit: SHA,
    authorities: { release: 'Release Person', database: 'Database Person', incident: 'Incident Person' },
    settings: {
      branch_rules: { state: 'unknown', evidence: [] },
      environment_rules: { state: 'unknown', evidence: [] },
      application_grants: { state: 'unknown', evidence: [] }
    },
    endpoint: { state: 'unknown' },
    database: { state: 'unknown' },
    release_procedure: procedure('Release Person'),
    incident_procedure: procedure('Incident Person'),
    ...overrides
  };
}

test('operations audit permits only explicit evidence states and binds every unknown to a procedure', () => {
  assert.equal(audit.schema, 'sideways-operations-reality/v1');
  const allowed = new Set(['verified', 'previously_verified', 'unknown']);
  const procedures = new Set(audit.procedures.map(item => item.id));
  for (const fact of audit.facts) {
    assert.ok(allowed.has(fact.state), `${fact.id} has invalid state`);
    if (fact.state === 'verified') assert.ok(fact.evidence.length > 0, `${fact.id} lacks evidence`);
    if (fact.state === 'unknown') {
      assert.deepEqual(fact.evidence, []);
      assert.ok(procedures.has(fact.procedure), `${fact.id} lacks executable procedure`);
    }
  }
  assert.ok(audit.next_proof.every(item => procedures.has(item.procedure)));
});

test('safe snapshot validation is deterministic and leaves unknown external facts unknown', () => {
  const validated = validateSnapshot(snapshot(), { expectedSha: SHA, now: NOW });
  const first = buildProbeReceipt(validated);
  const second = buildProbeReceipt(validateSnapshot(snapshot(), { expectedSha: SHA, now: NOW }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'partial');
  assert.equal(first.safety.read_only_default, true);
  assert.equal(first.safety.destructive_execution_performed, false);
});

test('hostile snapshots fail closed on date, commit, secrets, and unverifiable evidence', () => {
  assert.throws(() => validateSnapshot(snapshot({ observed_at: '' }), { expectedSha: SHA, now: NOW }), /canonical ISO/);
  assert.throws(() => validateSnapshot(snapshot({ authorized_commit: 'b'.repeat(40) }), { expectedSha: SHA, now: NOW }), /stale|does not match/);
  assert.throws(() => validateSnapshot({ ...snapshot(), api_token: 'forbidden' }, { expectedSha: SHA, now: NOW }), /Secret-bearing/);
  const badSettings = snapshot(); badSettings.settings.branch_rules = { state: 'verified', evidence: [] };
  assert.throws(() => validateSnapshot(badSettings, { expectedSha: SHA, now: NOW }), /non-empty redacted evidence/);
});

test('database evidence requires explicit disposable proof, restore, and rollback', () => {
  const database = {
    state: 'verified', target_kind: 'disposable', target: 'sideways-ci-fixture', confirmation: 'I_USED_A_DISPOSABLE_DATABASE',
    migration: { success: true, observed_at: OBSERVED, evidence: evidence('migration digest') },
    backup: { success: true, observed_at: OBSERVED, evidence: evidence('backup digest') },
    restore: { success: true, observed_at: OBSERVED, evidence: evidence('restore digest') },
    rollback: { success: true, observed_at: OBSERVED, evidence: evidence('rollback digest') }
  };
  assert.throws(() => validateSnapshot(snapshot({ database }), { expectedSha: SHA, now: NOW }), /--accept-disposable-database/);
  const validated = validateSnapshot(snapshot({ database }), { expectedSha: SHA, now: NOW, allowDatabaseEvidence: true });
  assert.equal(validated.database.state, 'verified');
  assert.throws(() => validateSnapshot(snapshot({ database: { ...database, target: 'production-primary' } }), { expectedSha: SHA, now: NOW, allowDatabaseEvidence: true }), /Production database targets are forbidden/);
  assert.throws(() => validateSnapshot(snapshot({ database: { state: 'unknown', backup: { success: true }, restore: { success: false } } }), { expectedSha: SHA, now: NOW }), /backup without a successful restore/);
  const missingRollback = structuredClone(database); delete missingRollback.rollback;
  assert.throws(() => validateSnapshot(snapshot({ database: missingRollback }), { expectedSha: SHA, now: NOW, allowDatabaseEvidence: true }), /database.rollback/);
});

test('read-only endpoint probe binds sentinel to exact commit without exercising rate limits', async () => {
  const fetchImpl = async url => {
    if (String(url).includes('sideways-deployment.json')) return new Response(JSON.stringify({ commit: SHA }), { status: 200, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } });
    return new Response(JSON.stringify({ account: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const live = await probePublicEndpoint('https://sideways.example', { expectedSha: SHA, fetchImpl });
  assert.equal(live.commit_matches, true);
  assert.equal(live.rate_limit.state, 'not_exercised');
  assert.equal(live.function.status, 200);
  const mismatchFetch = async url => String(url).includes('sideways-deployment.json') ? new Response(JSON.stringify({ commit: 'b'.repeat(40) })) : new Response('{}');
  const mismatch = await probePublicEndpoint('https://sideways.example', { expectedSha: SHA, fetchImpl: mismatchFetch });
  assert.equal(mismatch.commit_matches, false);
  const validated = validateSnapshot(snapshot(), { expectedSha: SHA, now: NOW });
  assert.throws(() => buildProbeReceipt(validated, { live: mismatch }), /other than the authorized commit/);
});

test('runbook contains exact release, activation, disposable database, and incident stop paths', () => {
  for (const heading of ['Static release', 'Relational activation', 'Disposable database proof', 'Incident and rollback']) assert.match(runbook, new RegExp(`## ${heading}`));
  assert.match(runbook, /--allow-network/);
  assert.match(runbook, /--accept-disposable-database/);
  assert.match(runbook, /Never run the drill against production/);
  assert.match(runbook, /Stop if/);
});
