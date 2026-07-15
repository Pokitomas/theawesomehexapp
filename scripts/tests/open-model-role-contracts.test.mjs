import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenModelRoleAdapter, roleSystemPrompt } from '../open-model-adapter.mjs';

const roles = ['proposer', 'opponent', 'verifier', 'implementer', 'integrator', 'historian', 'critic'];

test('Maker planning roles receive materially distinct bounded contracts', () => {
  const prompts = roles.map(role => roleSystemPrompt(role));
  assert.equal(new Set(prompts).size, roles.length);
  assert.match(roleSystemPrompt('proposer'), /smallest executable plan/i);
  assert.match(roleSystemPrompt('opponent'), /contradiction/i);
  assert.match(roleSystemPrompt('verifier'), /decisive witnesses/i);
  assert.match(roleSystemPrompt('critic'), /admission, revision, or rejection/i);
  for (const prompt of prompts) {
    assert.match(prompt, /Never return private chain-of-thought/);
    assert.match(prompt, /Do not emit decisions or authority actions/);
  }
  assert.throws(() => roleSystemPrompt('imaginary'), /Unsupported planning role/);
});

test('role adapter binds the declared role and rejects packet drift', async () => {
  const calls = [];
  const client = {
    async complete(messages) {
      calls.push(messages);
      return { text: '{"events":[]}' };
    }
  };
  const adapter = createOpenModelRoleAdapter(client, { id: 'test:opponent', role: 'opponent' });
  assert.equal(adapter.role, 'opponent');
  assert.deepEqual(await adapter.execute({ assignment: { role: 'opponent' } }), []);
  assert.match(calls[0][0].content, /Attack the leading plan/);
  await assert.rejects(
    adapter.execute({ assignment: { role: 'proposer' } }),
    /Role packet mismatch/
  );
});
