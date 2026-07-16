import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFailure,
  createDeliveryLoop,
  deliveryDigest,
  normalizeCheck,
  normalizeReviewItem,
  redactDeliverySecrets,
} from '../maker-delivery-loop.mjs';

const sha = char => char.repeat(40);
function clock() {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  return { now: () => now, advance: ms => { now += ms; } };
}
const green = head => [
  { id: 1, name: 'tests', status: 'completed', conclusion: 'success', head_sha: head },
  { id: 2, name: 'policy', status: 'completed', conclusion: 'success', head_sha: head },
];

test('normalizes GitHub and external checks into exact states', () => {
  assert.equal(normalizeCheck({ name: 'a', conclusion: 'success' }, sha('a')).state, 'success');
  assert.equal(normalizeCheck({ name: 'b', status: 'in_progress' }, sha('a')).state, 'running');
  assert.equal(normalizeCheck({ name: 'c', state: 'HTTP 503' }, sha('a')).state, 'unknown');
});

test('classifies required failure families', () => {
  assert.equal(classifyFailure({ name: 'unit' }, 'AssertionError test failed').classification, 'code_local');
  assert.equal(classifyFailure({ name: 'api' }, 'HTTP 503 service unavailable').classification, 'external_service');
  assert.equal(classifyFailure({ name: 'auth' }, 'permission denied 403').classification, 'permissions');
  assert.equal(classifyFailure({ name: 'config' }, 'missing env token required').classification, 'secrets_configuration');
  assert.equal(classifyFailure({ name: 'runner' }, 'runner image environment mismatch').classification, 'environment');
  assert.equal(classifyFailure({ name: 'authority manifest' }, 'policy protected path').classification, 'policy');
  assert.equal(classifyFailure({ name: 'race' }, 'flaky retryable').classification, 'flaky_retryable');
});

test('green path becomes ready and produces deterministic receipt', async () => {
  const c = clock();
  const loop = createDeliveryLoop({ repository: 'o/r', branch: 'x', prNumber: 1, headSha: sha('a'), requiredChecks: ['tests','policy'], clock: c.now });
  await loop.observeChecks(green(sha('a')));
  assert.equal(loop.readiness().ready, true);
  const a = loop.receipt();
  const b = loop.receipt();
  assert.deepEqual(a, b);
  assert.match(a.receipt_digest, /^[a-f0-9]{64}$/);
});

test('failing check creates exact repair and new head requires new checks', async () => {
  const loop = createDeliveryLoop({ repository: 'o/r', headSha: sha('a'), requiredChecks: ['tests'] });
  await loop.observeChecks([{ id: 1, name: 'tests', conclusion: 'failure', head_sha: sha('a'), evidence: { output: 'AssertionError' } }]);
  const assignment = await loop.createRepairAssignment({ files: ['a.js'], tests: ['unit'] });
  assert.equal(assignment.source_head_sha, sha('a'));
  await loop.recordRepairResult({ ok: true, new_head_sha: sha('b'), commit: sha('b') });
  assert.equal(loop.readiness().ready, false);
  assert.deepEqual(loop.readiness().missing, ['tests']);
  await loop.observeChecks(green(sha('b')).slice(0,1));
  assert.equal(loop.readiness().ready, true);
});

test('stale success is rejected', async () => {
  const loop = createDeliveryLoop({ headSha: sha('b'), requiredChecks: ['tests'] });
  await loop.observeChecks([{ id: 1, name: 'tests', conclusion: 'success', head_sha: sha('a') }]);
  assert.equal(loop.readiness().ready, false);
  assert.equal(loop.readiness().stale.length, 1);
});

test('poll handles flaky/rate-limited retries and bounded backoff', async () => {
  let calls = 0;
  const sleeps = [];
  const loop = createDeliveryLoop({
    headSha: sha('a'),
    requiredChecks: ['tests'],
    sleep: async ms => sleeps.push(ms),
    github: {
      async listChecks() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('rate limit'), { status: 429 });
        if (calls === 2) return { checks: [{ name: 'tests', status: 'in_progress', head_sha: sha('a') }] };
        return { checks: [{ name: 'tests', conclusion: 'success', head_sha: sha('a') }] };
      }
    }
  });
  const result = await loop.poll({ maxAttempts: 4, backoffMs: [1,2,3] });
  assert.equal(result.state, 'success');
  assert.deepEqual(sleeps, [1,2]);
});

test('external and permission blockers remain explicit', async () => {
  const loop = createDeliveryLoop({
    headSha: sha('a'),
    github: { async getJobLog(check) { return check.name === 'service' ? 'HTTP 503' : 'permission denied 403'; } }
  });
  const result = await loop.observeChecks([
    { id: 1, name: 'service', conclusion: 'failure' },
    { id: 2, name: 'permissions', conclusion: 'failure' },
  ]);
  assert.deepEqual(result.failures.map(x => x.classification), ['external_service','permissions']);
});

test('pause cancel and hydrate preserve durable state', async () => {
  let saved;
  const store = { async load(){ return saved; }, async save(value){ saved = structuredClone(value); } };
  const first = createDeliveryLoop({ headSha: sha('a'), store });
  await first.pause('human');
  const second = createDeliveryLoop({ store });
  await second.hydrate();
  assert.equal(second.snapshot().paused, true);
  await second.resume();
  await second.cancel();
  assert.equal(second.snapshot().cancelled, true);
});

test('review ingestion deduplicates and unresolved requested changes block readiness', async () => {
  const loop = createDeliveryLoop({ headSha: sha('a') });
  await loop.observeChecks([]);
  await loop.ingestReviews([
    { id: 1, type: 'inline_thread', body: 'please fix this', path: 'a.js', state: 'changes_requested' },
    { id: 1, type: 'inline_thread', body: 'please fix this', path: 'a.js', state: 'changes_requested' },
  ]);
  assert.equal(loop.snapshot().reviews.length, 1);
  assert.equal(loop.readiness().ready, false);
  await loop.ingestReviews([{ id: 1, type: 'inline_thread', body: 'fixed', path: 'a.js', resolved: true }]);
  assert.equal(loop.readiness().ready, true);
});

test('review normalization maps human commands to actionable work', () => {
  const item = normalizeReviewItem({ id: 'x', type: 'human_command', command: 'rollback', body: 'rollback production' });
  assert.equal(item.actionable, true);
});

test('release receipt binds exact head checks and rollback plan', async () => {
  const loop = createDeliveryLoop({ repository: 'o/r', branch: 'release', prNumber: 7, headSha: sha('a'), requiredChecks: ['tests'] });
  await loop.observeChecks([{ name: 'tests', conclusion: 'success', head_sha: sha('a') }]);
  const release = await loop.createRelease({ version: '1.2.3', notes: 'safe', rollback: { available: true, target_head_sha: sha('0') } });
  assert.equal(release.head_sha, sha('a'));
  assert.equal(release.rollback.target_head_sha, sha('0'));
});

test('preview canary and production require exact scoped unexpired authority', async () => {
  const c = clock();
  const loop = createDeliveryLoop({ headSha: sha('a'), clock: c.now });
  await loop.observeChecks([]);
  await loop.createRelease({ version: 'x' });
  const preview = await loop.requestDeployment({ environment: 'preview' });
  assert.equal(preview.state, 'human_approval_required');
  const authority = { schema: 'sideways-maker-deployment-authority/v1', environment: 'canary', head_sha: sha('a'), allowed: true, expires_at: '2026-07-16T00:00:00.000Z' };
  const canary = await loop.requestDeployment({ environment: 'canary', authority });
  assert.equal(canary.state, 'authorized_request');
  const wrong = await loop.requestDeployment({ environment: 'production', authority });
  assert.equal(wrong.state, 'human_approval_required');
  const dry = await loop.requestDeployment({ environment: 'dry-run' });
  assert.equal(dry.state, 'authorized_request');
});

test('sentinel mismatch produces rollback request', async () => {
  const loop = createDeliveryLoop({ headSha: sha('a') });
  await loop.observeChecks([]);
  await loop.createRelease({ version: 'x', rollback: { available: true, target_head_sha: sha('0') } });
  await loop.requestDeployment({ environment: 'dry-run' });
  const verification = await loop.verifySentinel({ observed_head_sha: sha('b'), sentinel: 'wrong' });
  assert.equal(verification.ok, false);
  assert.equal(loop.snapshot().deployments.at(-1).state, 'sentinel_mismatch');
  const rollback = await loop.requestRollback('sentinel mismatch');
  assert.equal(rollback.target_head_sha, sha('0'));
  assert.equal(rollback.state, 'human_approval_required');
});

test('secrets are recursively redacted from logs events and receipts', async () => {
  const token = `ghp_${'a'.repeat(30)}`;
  const loop = createDeliveryLoop({ headSha: sha('a'), github: { async getJobLog(){ return `Authorization: Bearer ${token}`; } } });
  await loop.observeChecks([{ name: 'tests', conclusion: 'failure', evidence: { token } }]);
  const serialized = JSON.stringify(loop.receipt());
  assert.ok(!serialized.includes(token));
  assert.ok(serialized.includes('[redacted]'));
  assert.deepEqual(redactDeliverySecrets({ password: 'x', nested: `Bearer ${token}` }), { password: '[redacted]', nested: '[redacted]' });
});

test('receipt integrity changes with evidence and is stable otherwise', async () => {
  const loop = createDeliveryLoop({ headSha: sha('a') });
  const before = loop.receipt().receipt_digest;
  await loop.observeChecks([{ name: 'tests', conclusion: 'success', head_sha: sha('a') }]);
  const after = loop.receipt().receipt_digest;
  assert.notEqual(before, after);
  assert.equal(after, deliveryDigest({ ...loop.receipt(), receipt_digest: undefined }));
});
