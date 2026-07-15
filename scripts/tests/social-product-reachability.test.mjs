import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/social-product-reachability.json'));
const client = await read(audit.consumer_client);
const server = await read(audit.relational_service);

function serverHas(operation) {
  const [op, method = ''] = operation.split(':');
  const pattern = method === 'get'
    ? new RegExp(`request\\.method === 'GET' && op === '${op}'`)
    : method === 'patch'
      ? new RegExp(`request\\.method === 'PATCH' && op === '${op}'`)
      : new RegExp(`op === '${op}'`);
  return pattern.test(server);
}

test('every operation called by the current consumer is admitted by the server', () => {
  for (const op of audit.visible_operations) {
    assert.match(client, new RegExp(`['\"]${op}['\"]`), `client does not expose ${op}`);
    assert.ok(serverHas(op), `server does not admit ${op}`);
  }
});

test('server-only authority is real but absent from the current client', () => {
  for (const operation of audit.server_only_operations) {
    assert.ok(serverHas(operation), `missing server operation ${operation}`);
    const op = operation.split(':')[0];
    assert.doesNotMatch(client, new RegExp(`request\\(['\"]${op}['\"]`), `client unexpectedly reaches ${operation}`);
  }
  assert.ok(audit.highest_priority_gaps.length >= 6);
});

test('static mode fails unavailable instead of simulating shared state', () => {
  assert.match(client, /available = false/);
  assert.match(client, /\[404, 405, 501\]/);
  assert.match(audit.mode_contract.static, /must not simulate shared mutation/);
  assert.match(audit.release_rule, /not a product feature until the consumer can reach it/);
});
