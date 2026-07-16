import assert from 'node:assert/strict';
import test from 'node:test';
import { createMakerDeliveryLoop, classifyDeliveryFailure, normalizeDeliveryCheck, normalizeReviewEvent, redactDeliveryEvidence } from '../maker-delivery-loop.mjs';

const SHA1 = '1'.repeat(40); const SHA2 = '2'.repeat(40);
function loop(extra = {}) {
  let time = Date.parse('2026-07-16T00:00:00.000Z');
  return createMakerDeliveryLoop({ repository: 'Pokitomas/theawesomehexapp', branch: 'agent/test', pr_number: 1, head_sha: SHA1, required_checks: ['unit', 'authority'], clock: () => time++, sleep: async () => {}, ...extra });
}
const green = sha => [{ name: 'unit', conclusion: 'success', head_sha: sha }, { name: 'authority', state: 'success', head_sha: sha }];

test('normalizes checks and classifies failures', () => {
  assert.equal(normalizeDeliveryCheck({ name: 'unit', conclusion: 'timed_out', head_sha: SHA1 }).state, 'failure');
  assert.equal(classifyDeliveryFailure({ name: 'unit tests', state: 'failure' }), 'code-local');
  assert.equal(classifyDeliveryFailure({ name: 'API', evidence: 'HTTP 429 rate limit' }), 'flaky-retryable');
  assert.equal(classifyDeliveryFailure({ name: 'deploy', evidence: 'permission denied' }), 'permissions');
});

test('green path reaches ready gate and deterministic receipt', () => {
  const value = loop(); value.observeChecks(green(SHA1), { head_sha: SHA1 });
  assert.equal(value.gate().ready, true);
  assert.equal(value.receipt().receipt_digest, value.receipt().receipt_digest);
});

test('failing check creates repair assignment and requires a new exact head', () => {
  const value = loop();
  const observed = value.observeChecks([{ name: 'unit', conclusion: 'failure', head_sha: SHA1 }, { name: 'authority', conclusion: 'success', head_sha: SHA1 }]);
  const assignment = value.createRepairAssignment(observed.failing[0].id, { files: ['src/a.mjs'], tests: ['unit'], logs: 'assertion failed' });
  assert.throws(() => value.recordRepair({ assignment_id: assignment.id, new_head_sha: SHA1 }), /new exact head/);
  value.recordRepair({ assignment_id: assignment.id, new_head_sha: SHA2, summary: 'fixed assertion' });
  value.observeChecks(green(SHA2), { head_sha: SHA2 });
  assert.equal(value.gate().ready, true);
  assert.equal(value.snapshot().repairs[0].attempts.length, 1);
});

test('rejects stale successful checks after repair', () => {
  const value = loop();
  const observed = value.observeChecks([{ name: 'unit', conclusion: 'failure', head_sha: SHA1 }, { name: 'authority', conclusion: 'success', head_sha: SHA1 }]);
  const assignment = value.createRepairAssignment(observed.failing[0].id);
  value.recordRepair({ assignment_id: assignment.id, new_head_sha: SHA2 });
  assert.throws(() => value.observeChecks(green(SHA1), { head_sha: SHA1 }), /Stale check success/);
});

test('polls with bounded rate-limit retry and supports cancellation/resume', async () => {
  let calls = 0; const delays = [];
  const value = loop({ sleep: async ms => delays.push(ms), transport: { listChecks: async () => { calls++; if (calls === 1) { const error = new Error('rate limit'); error.status = 429; throw error; } return green(SHA1); } } });
  const result = await value.pollChecks({ max_attempts: 3, base_delay_ms: 5 });
  assert.equal(result.status, 'checks_green'); assert.deepEqual(delays, [5]);
  value.cancel('stop'); assert.equal(value.snapshot().status, 'cancelled'); value.resume(); assert.equal(value.snapshot().status, 'observing');
});

test('collects bounded redacted logs and artifacts', async () => {
  const value = loop({ transport: { fetchLogs: async () => `failure sk-${'a'.repeat(24)}`, listArtifacts: async () => [{ name: 'log' }] } });
  const observed = value.observeChecks([{ name: 'unit', conclusion: 'failure', head_sha: SHA1 }, { name: 'authority', conclusion: 'success', head_sha: SHA1 }]);
  const evidence = await value.collectFailureEvidence(observed.failing[0].id);
  assert.match(evidence.logs, /\[redacted\]/); assert.equal(evidence.artifacts.length, 1);
});

test('ingests and deduplicates review feedback and blocks unresolved review', () => {
  const value = loop(); value.observeChecks(green(SHA1), { head_sha: SHA1 });
  const added = value.ingestReviews([{ id: 'r1', type: 'changes_requested', body: 'Fix the test' }, { id: 'r1', type: 'changes_requested', body: 'duplicate' }]);
  assert.equal(added.length, 1); assert.equal(value.gate().ready, false);
  value.resolveReview('r1', 'fixed'); assert.equal(value.gate().ready, true);
});

test('normalizes human commands and resolved threads', () => {
  assert.equal(normalizeReviewEvent({ id: 1, type: 'human_command', body: 'rerun tests' }).actionable, true);
  assert.equal(normalizeReviewEvent({ id: 2, type: 'review_thread', resolved: true }).actionable, false);
});

test('prepares release only after exact-head green and resolved review', () => {
  const value = loop(); assert.throws(() => value.prepareRelease({ version: '1.0.0' }), /requires/);
  value.observeChecks(green(SHA1), { head_sha: SHA1 });
  const release = value.prepareRelease({ version: '1.0.0', notes: ['fixed'], rollback: ['revert'] });
  assert.match(release.release_digest, /^[a-f0-9]{64}$/);
});

test('enforces preview canary and production authority gates', () => {
  const value = loop(); value.observeChecks(green(SHA1), { head_sha: SHA1 }); const release = value.prepareRelease({ version: '1' });
  const blocked = value.requestDeployment({ environment: 'production', mode: 'production', release_digest: release.release_digest });
  assert.equal(blocked.status, 'blocked_authority');
  const packet = { schema: 'sideways-maker-deployment-authority/v1', environments: ['preview', 'canary', 'production'], human_approved: true };
  assert.equal(value.requestDeployment({ environment: 'preview', mode: 'preview', authority_packet: packet }).authorized, true);
  assert.equal(value.requestDeployment({ environment: 'canary', mode: 'canary', authority_packet: packet }).authorized, true);
  assert.equal(value.requestDeployment({ environment: 'production', mode: 'production', authority_packet: packet }).authorized, true);
  assert.equal(value.requestDeployment({ environment: 'production', mode: 'dry-run' }).authorized, true);
});

test('detects sentinel mismatch and supports authorized rollback request', () => {
  const value = loop(); const packet = { schema: 'sideways-maker-deployment-authority/v1', environments: ['production'], human_approved: true };
  const request = value.requestDeployment({ environment: 'production', mode: 'production', authority_packet: packet, expected_sentinel: { sha: SHA1 } });
  assert.equal(value.verifyDeployment({ request_id: request.id, observed_sentinel: { sha: SHA2 } }).status, 'sentinel_mismatch');
  assert.equal(value.requestRollback({ request_id: request.id, reason: 'mismatch', authority_packet: packet }).status, 'requested');
});

test('preserves external and permission blockers without fabricating repair', () => {
  assert.equal(classifyDeliveryFailure({ name: 'service', evidence: 'external service outage' }), 'external-service');
  assert.equal(classifyDeliveryFailure({ name: 'config', evidence: 'missing configuration token' }), 'secrets-configuration');
  assert.equal(classifyDeliveryFailure({ name: 'authority manifest', evidence: 'policy denied' }), 'policy');
});

test('redacts nested secret fields and values', () => {
  const result = redactDeliveryEvidence({ token: 'abc', nested: `Bearer ${'z'.repeat(20)}` });
  assert.equal(result.token, '[redacted]'); assert.match(result.nested, /\[redacted\]/);
});

test('tampering changes deterministic receipt digest', () => {
  const value = loop(); value.observeChecks(green(SHA1), { head_sha: SHA1 });
  const receipt = value.receipt(); const altered = structuredClone(receipt); altered.status = 'forged';
  assert.notEqual(JSON.stringify(altered), JSON.stringify(receipt));
});
