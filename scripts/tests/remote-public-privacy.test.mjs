import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  defaultState,
  publicMessageProjection,
  publicStateProjection
} from '../../netlify/functions/remote-core.mjs';
import { sanitizePublicRemoteResponse } from '../../netlify/functions/remote-public-response.mjs';

const secrets = [
  'private-signing-key',
  'grant-admin-everything',
  'nonce-should-never-render',
  'credential-password',
  'hidden-recode-position',
  'future-private-field'
];

function hostileMessage() {
  return {
    id: 'hostile-public-event',
    session: 'Pokitomas/theawesomehexapp:test',
    generation: 1,
    issuer: 'agent-one',
    parent: null,
    issued_at: '2026-07-14T00:00:00.000Z',
    expires_at: null,
    head_sha: 'a'.repeat(40),
    scope: ['public-summary'],
    visibility: 'public',
    signature: secrets[0],
    nonce: secrets[2],
    payload: {
      summary: 'Useful public progress summary.',
      credentials: { password: secrets[3] },
      grant: { capability: secrets[1] },
      recode: { private_position: secrets[4] },
      future: { unknown_payload: secrets[5] },
      evidence: {
        checks: [{ name: 'safe', secret: secrets[0] }],
        artifacts: [{ name: 'proof', token: secrets[3] }],
        active_blockers: 0,
        remaining_test_records: 0
      }
    }
  };
}

function assertNoPrivateResidue(value) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
}

test('public projections preserve explicit summaries and counts without generic payload residue', () => {
  const message = hostileMessage();
  const projected = publicMessageProjection(message);
  assert.equal(projected.summary, 'Useful public progress summary.');
  assert.equal(projected.evidence.checks, 1);
  assert.equal(projected.evidence.artifacts, 1);
  assert.equal('payload' in projected, false);
  assertNoPrivateResidue(projected);

  const state = publicStateProjection(defaultState(message.session), [message]);
  assert.equal(state.messages[0].summary, projected.summary);
  assert.equal('payload' in state.messages[0], false);
  assertNoPrivateResidue(state);
});

test('the production-edge public message response is structurally sanitized', async () => {
  const message = hostileMessage();
  const request = new Request('https://sideways.test/api/remote?public=1');
  const response = new Response(JSON.stringify({
    session: message.session,
    generation: 1,
    messages: [message],
    state: { messages: [message] }
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const sanitized = await sanitizePublicRemoteResponse(request, response);
  const body = await sanitized.json();
  assert.equal(body.messages[0].summary, 'Useful public progress summary.');
  assert.equal('payload' in body.messages[0], false);
  assert.equal('payload' in body.state.messages[0], false);
  assertNoPrivateResidue(body);
});

test('LIVE rendering cannot fall back to generic message payloads', async () => {
  const source = await readFile(new URL('../../studio/manual/product/remote-terminal.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /message\.payload/);
  assert.match(source, /message\.summary \|\| 'Work updated\.'/);
});
