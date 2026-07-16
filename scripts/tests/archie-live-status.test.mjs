import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULTS,
  STATUS_MARKER,
  normalizeTokenState,
  parseHeartbeat,
  parseTokenUpdate,
  publishHeartbeat,
  renderDashboard,
  renderHeartbeat,
  selectHeartbeat,
  tokenBar
} from '../archie-live-status.mjs';

test('token updates preserve the explicit total and reject impossible values', () => {
  const current = normalizeTokenState({ total: 1000, remaining: 900 });
  const updated = parseTokenUpdate(['750'], current);
  assert.deepEqual({ ...updated, updated_at: '<observed>' }, {
    schema: 'archie-token-state/v1',
    total: 1000,
    remaining: 750,
    used: 250,
    source: 'manual-observed',
    updated_at: '<observed>'
  });
  assert.match(updated.updated_at, /^2026-|^20\d{2}-/);
  assert.throws(() => parseTokenUpdate(['1001', '1000'], current), /0 <= remaining <= total/);
});

test('heartbeat selection prefers the newest coordination receipt', () => {
  const older = { id: 1, body: 'active writer: one\nnext: old', updated_at: '2026-07-16T01:00:00Z', user: { login: 'a' } };
  const newer = { id: 2, body: `${STATUS_MARKER}\n- writer: one\n- mode: sidecar\n- next: repair seam`, updated_at: '2026-07-16T02:00:00Z', user: { login: 'b' } };
  const selected = selectHeartbeat([newer, older]);
  assert.equal(selected.id, 2);
  assert.equal(selected.writer, 'one');
  assert.equal(selected.mode, 'sidecar');
  assert.equal(selected.next, 'repair seam');
  assert.equal(parseHeartbeat({ body: 'ordinary comment' }), null);
});

test('phone dashboard is compact and exposes head drift, tokens, heartbeat and PR state', () => {
  const output = renderDashboard({
    issue: 351,
    issueState: 'open',
    head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expectedHead: DEFAULTS.expectedHead,
    tokens: normalizeTokenState({ total: 1000, remaining: 500 }),
    heartbeat: { writer: 'one', mode: 'working', updated_at: '2026-07-16T01:59:30Z', next: 'repair router seam' },
    pullRequest: { number: 400, state: 'draft' }
  }, { now: Date.parse('2026-07-16T02:00:00Z'), width: 44 });
  assert.match(output, /ARCHIE #351  OPEN/);
  assert.match(output, /HEAD   aaaaaaa  DRIFT/);
  assert.match(output, /TOKENS 500 \/ 1,000/);
  assert.match(output, /BEAT   30s ago/);
  assert.match(output, /PR     #400 draft/);
  assert.ok(output.split('\n').every(line => line.length <= 44));
  assert.equal(tokenBar(normalizeTokenState({ total: 10, remaining: 5 }), 4), '[==..]');
});

test('published heartbeat is receipt-only and does not expose authentication', () => {
  const body = renderHeartbeat({
    branch: DEFAULTS.branch,
    head: DEFAULTS.expectedHead,
    expectedHead: DEFAULTS.expectedHead,
    tokens: normalizeTokenState({ total: DEFAULTS.totalTokens, remaining: DEFAULTS.totalTokens }),
    heartbeat: null
  }, 'observe writer');
  assert.match(body, new RegExp(STATUS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, /drift: none/);
  assert.match(body, /execution|token/i);
  assert.doesNotMatch(body, /ghp_|github_pat_|Bearer /);
  assert.match(body, /No merge or deployment/);
});

test('heartbeat publication updates the stable marker instead of spamming comments', async () => {
  const calls = [];
  const client = {
    request: async (route, options) => {
      calls.push({ route, options });
      return { id: 99 };
    }
  };
  const updated = await publishHeartbeat({
    client,
    issue: 351,
    comments: [{ id: 12, body: STATUS_MARKER }],
    body: 'new'
  });
  assert.deepEqual(updated, { action: 'updated', id: 12 });
  assert.equal(calls[0].route, '/issues/comments/12');
  assert.equal(calls[0].options.method, 'PATCH');

  calls.length = 0;
  const created = await publishHeartbeat({ client, issue: 351, comments: [], body: 'new' });
  assert.deepEqual(created, { action: 'created', id: 99 });
  assert.equal(calls[0].route, '/issues/351/comments');
  assert.equal(calls[0].options.method, 'POST');
});
