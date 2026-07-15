import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateRemoteWeaveEnvelope,
  validateRemoteWeaveRequest
} from '../../netlify/functions/remote-weave-envelope.mjs';
import { createWeaveEvent, strictWeavePayload } from '../weave-replay-integrity.mjs';

const issuedAt = '2026-07-15T04:00:00.000Z';

function event(kind, visibility) {
  const body = kind === 'message'
    ? { message_type: 'note', statement: 'private content' }
    : { beacon_id: 'beacon:privacy', kind: 'join_me', signal: 'coordinate privately', useful_contribution: [], urgency: 80, desired_agents: 1 };
  return createWeaveEvent({
    id: `event:${kind}:${visibility}`,
    kind,
    issuer: 'agent:writer',
    issued_at: issuedAt,
    visibility,
    body
  });
}

function message(weave, visibility = weave.visibility) {
  return {
    id: `remote:${weave.id}`,
    session: 'Pokitomas/theawesomehexapp:main',
    generation: 1,
    issuer: weave.issuer,
    issued_at: weave.issued_at,
    visibility,
    payload: strictWeavePayload(weave)
  };
}

test('valid matching weave envelope passes pre-storage validation', () => {
  const weave = event('beacon.emit', 'public');
  const checked = validateRemoteWeaveEnvelope(message(weave));
  assert.equal(checked.visibility, 'public');
  assert.equal(checked.payload.weave.visibility, 'public');
});

test('public envelope carrying an explicitly private event is rejected', () => {
  const weave = event('beacon.emit', 'private');
  assert.throws(
    () => validateRemoteWeaveEnvelope(message(weave, 'public')),
    error => error?.code === 'WEAVE_VISIBILITY_MISMATCH'
  );
});

test('legacy private-default event cannot be widened by a public envelope', () => {
  const weave = event('message', 'private');
  const payload = strictWeavePayload(weave);
  delete payload.weave.visibility;
  assert.throws(
    () => validateRemoteWeaveEnvelope({ ...message(weave, 'public'), payload }),
    error => error?.code === 'WEAVE_VISIBILITY_MISMATCH'
  );
});

test('signed header defaults are applied before validating a weave request', async () => {
  const weave = event('beacon.emit', 'public');
  const input = message(weave);
  delete input.issuer;
  delete input.issued_at;
  const request = new Request('https://sideways.example/api/remote', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': weave.issuer,
      'x-remote-timestamp': weave.issued_at
    },
    body: JSON.stringify({ message: input })
  });
  const checked = await validateRemoteWeaveRequest(request);
  assert.equal(checked.issuer, weave.issuer);
  assert.equal(checked.issued_at, weave.issued_at);
});

test('non-weave Remote messages remain outside this validator', () => {
  assert.equal(validateRemoteWeaveEnvelope({ payload: { summary: 'ordinary message' } }), null);
});
