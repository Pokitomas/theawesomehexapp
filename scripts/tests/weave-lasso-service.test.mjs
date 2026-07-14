import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LASSO_SYSTEM_PRINCIPAL,
  lassoRemoteArrival,
  remoteArrival
} from '../../netlify/functions/weave-lasso-service.mjs';

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async get(key, options = {}) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return options.type === 'json' ? structuredClone(value) : JSON.stringify(value);
  }

  async setJSON(key, value) {
    this.values.set(key, structuredClone(value));
  }

  messages() {
    return [...this.values.entries()]
      .filter(([key, value]) => key.includes('/messages/') && value?.payload)
      .map(([, value]) => structuredClone(value));
  }
}

function sourceMessage(issuer, id = `message-${issuer}`, summary = 'Inspect the social substrate.') {
  return {
    id,
    session: 'Pokitomas/theawesomehexapp:main',
    generation: 1,
    issuer,
    parent: null,
    issued_at: '2026-07-14T14:00:00Z',
    expires_at: null,
    head_sha: '0'.repeat(40),
    scope: [],
    payload: { summary },
    visibility: 'private',
    nonce: `nonce-${issuer}`,
    signature: 'signed',
    signature_algorithm: 'hmac-sha256',
    protocol_version: 1
  };
}

const state = {
  protocol_version: 1,
  session: 'Pokitomas/theawesomehexapp:main',
  generation: 1,
  head_sha: '0'.repeat(40)
};

test('turns a direct Remote principal into a stable ontology arrival', () => {
  const arrival = remoteArrival(sourceMessage('agent-one', 'm1', 'The corpus and social graph are confused.'));
  assert.equal(arrival.actor, 'agent-one');
  assert.equal(arrival.repository, 'Pokitomas/theawesomehexapp');
  assert.equal(arrival.default_branch, 'main');
  assert.equal(arrival.source_id, 'agent-one');
  assert.match(arrival.body, /social graph/);
});

test('stores private system-generated assembly seeds and invitations', async () => {
  const store = new MemoryStore();
  const result = await lassoRemoteArrival({
    store,
    message: sourceMessage('agent-one'),
    state,
    existingMessages: [],
    now: Date.parse('2026-07-14T14:01:00Z')
  });

  assert.equal(result.stored, 6);
  const messages = store.messages();
  assert.equal(messages.length, 6);
  assert.ok(messages.every(message => message.visibility === 'private'));
  assert.ok(messages.every(message => message.issuer === LASSO_SYSTEM_PRINCIPAL));
  assert.ok(messages.some(message => message.payload?.weave?.body?.thread_id === 'assembly:corpus-boundaries'));
});

test('does not recursively lasso internal lasso messages', async () => {
  const store = new MemoryStore();
  const result = await lassoRemoteArrival({
    store,
    message: sourceMessage(LASSO_SYSTEM_PRINCIPAL),
    state,
    existingMessages: []
  });
  assert.equal(result.skipped, true);
  assert.equal(result.stored, 0);
});

test('repeated messages from one principal do not create new invitations', async () => {
  const store = new MemoryStore();
  await lassoRemoteArrival({
    store,
    message: sourceMessage('agent-one', 'm1'),
    state,
    existingMessages: [],
    now: Date.parse('2026-07-14T14:01:00Z')
  });
  const before = store.messages();
  const second = await lassoRemoteArrival({
    store,
    message: sourceMessage('agent-one', 'm2'),
    state,
    existingMessages: before,
    now: Date.parse('2026-07-14T14:02:00Z')
  });
  assert.equal(second.stored, 0);
  assert.equal(store.messages().length, before.length);
});

test('a second direct principal collides in foundational rooms while retaining a contextual third room', async () => {
  const store = new MemoryStore();
  await lassoRemoteArrival({
    store,
    message: sourceMessage('agent-one', 'm1'),
    state,
    existingMessages: [],
    now: Date.parse('2026-07-14T14:01:00Z')
  });
  const result = await lassoRemoteArrival({
    store,
    message: sourceMessage('agent-two', 'm2', 'What is the actual comment, reply, and thread model?'),
    state,
    existingMessages: store.messages(),
    now: Date.parse('2026-07-14T14:02:00Z')
  });
  assert.equal(result.stored, 6);
  const rounds = store.messages().filter(message => message.payload?.weave?.body?.message_type === 'assembly.round');
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds.map(message => message.payload.weave.body.thread_id).sort(),
    ['assembly:corpus-boundaries', 'assembly:program-execution']
  );
  assert.ok(rounds.every(message => /direct contradiction/.test(message.payload.weave.body.statement)));
  assert.ok(store.messages().some(message => message.payload?.weave?.body?.thread_id === 'assembly:conversation-model'));
});
