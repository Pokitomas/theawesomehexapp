import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRemoteState, runRemoteGate } from '../scripts/remote-gate.mjs';

test('gate decisions preserve terminal and exact-head supersession', () => {
  assert.equal(decideRemoteState({ decision: 'proceed', head_sha: 'a' }, 'a'), 'proceed');
  assert.equal(decideRemoteState({ decision: 'pause', head_sha: 'a' }, 'a'), 'pause');
  assert.equal(decideRemoteState({ decision: 'proceed', head_sha: 'b' }, 'a'), 'superseded');
  assert.equal(decideRemoteState({ decision: 'stop', terminal: true }, 'a'), 'terminal');
  assert.equal(decideRemoteState({}, ''), 'proceed');
});

test('unconfigured remote proceeds and configured state gates normally', async () => {
  const unconfigured = await runRemoteGate({});
  assert.deepEqual(unconfigured, { decision: 'proceed', configured: false });
  const configured = await runRemoteGate({ REMOTE_URL: 'https://example.test', REMOTE_SESSION: 's', EXPECTED_HEAD: 'abc' }, async () => new Response(JSON.stringify({ state: { decision: 'pause', head_sha: 'abc', generation: 2 } }), { status: 200 }));
  assert.equal(configured.decision, 'pause');
  assert.equal(configured.state.generation, 2);
});

test('remote outage fails open unless explicitly required', async () => {
  const originalExit = process.exitCode;
  process.exitCode = undefined;
  const optional = await runRemoteGate({ REMOTE_URL: 'https://example.test', REMOTE_SESSION: 's' }, async () => { throw new Error('offline'); });
  assert.equal(optional.decision, 'proceed');
  assert.equal(process.exitCode, undefined);
  const required = await runRemoteGate({ REMOTE_URL: 'https://example.test', REMOTE_SESSION: 's', REMOTE_REQUIRED: '1' }, async () => { throw new Error('offline'); });
  assert.equal(required.decision, 'stop');
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExit;
});
