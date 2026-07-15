import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/social-product-reachability.json'));
const client = await read(audit.consumer_client);
const server = await read(audit.relational_service);

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parts(operation) {
  const [op, method] = operation.split(':');
  assert.ok(op && method, `operation must be method-qualified: ${operation}`);
  return { op, method: method.toUpperCase() };
}

function serverHas(operation) {
  const { op, method } = parts(operation);
  if (method === 'GET' && ['discover', 'feed'].includes(op)) {
    return server.includes("request.method === 'GET' && (op === 'discover' || op === 'feed')");
  }
  return new RegExp(`request\\.method === '${method}' && op === '${escape(op)}'`).test(server);
}

function clientHas(operation) {
  const { op, method } = parts(operation);
  if (method === 'POST' && ['register', 'login'].includes(op)) {
    return client.includes("request(register ? 'register' : 'login'") && client.includes("method: 'POST'");
  }
  if (method === 'GET' && ['discover', 'feed'].includes(op)) {
    return client.includes("requestedMode === 'following' ? 'feed' : 'discover'");
  }
  const direct = new RegExp(`request\\(['\"]${escape(op)}['\"]\\s*(?:,\\s*\\{([\\s\\S]{0,220}?))?\\)`);
  const match = client.match(direct);
  if (!match) return false;
  const options = match[1] || '';
  if (method === 'GET') return !/method:\s*['\"]/.test(options);
  return new RegExp(`method:\\s*['\"]${method}['\"]`).test(options);
}

test('every visible consumer capability is admitted by the server with the same method', () => {
  for (const operation of audit.visible_operations) {
    assert.ok(clientHas(operation), `client does not expose ${operation}`);
    assert.ok(serverHas(operation), `server does not admit ${operation}`);
  }
});

test('server-only authority is real and absent from the current client at that method', () => {
  for (const operation of audit.server_only_operations) {
    assert.ok(serverHas(operation), `missing server operation ${operation}`);
    assert.equal(clientHas(operation), false, `client unexpectedly reaches ${operation}`);
  }
  assert.ok(audit.highest_priority_gaps.length >= 6);
});

test('static mode fails unavailable instead of simulating shared state', () => {
  assert.match(client, /available = false/);
  assert.match(client, /\[404, 405, 501\]/);
  assert.match(audit.mode_contract.static, /must not simulate shared mutation/);
  assert.match(audit.release_rule, /exact operation and HTTP method/);
});
