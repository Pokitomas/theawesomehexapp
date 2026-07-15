import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/social-product-reachability.json'));
const clientPaths = [audit.consumer_client, ...(audit.consumer_client_extensions || [])];
const client = (await Promise.all(clientPaths.map(read))).join('\n');
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
  if (method === 'POST' && op === 'post-state') {
    return client.includes("fetch(`${API}?op=post-state`")
      && client.includes("method: 'POST'")
      && client.includes('JSON.stringify({ postId, active: false })');
  }
  const direct = new RegExp(`request\\(['\"]${escape(op)}['\"]\\s*(?:,\\s*\\{([\\s\\S]{0,500}?))?\\)`, 'g');
  const calls = [...client.matchAll(direct)];
  return calls.some(match => {
    const options = match[1] || '';
    if (method === 'GET') return !/method:\s*['\"]/.test(options);
    return new RegExp(`method:\\s*['\"]${method}['\"]`).test(options);
  });
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
  assert.ok(audit.highest_priority_gaps.length >= 5);
});

test('public profile editing is a visible server-backed journey with local identity separation', () => {
  assert.ok(clientHas('profile:get'));
  assert.ok(clientHas('profile:patch'));
  assert.match(client, /data\.socialProfile|dataset\.socialProfile/);
  assert.match(client, /Local archive identity was not changed/);
  assert.match(audit.profile_journey, /retains the separate local archive identity/);
});

test('author-owned public removal is visible without touching the private archive', () => {
  assert.ok(clientHas('post-state:post'));
  assert.match(client, /record\?\.social\?\.mine/);
  assert.match(client, /Your private archive records will not be changed/);
  assert.match(client, /Private archive unchanged/);
  assert.match(audit.newly_visible_journey, /private archive records are unaffected/);
});

test('static mode fails unavailable instead of simulating shared state', () => {
  assert.match(client, /available = false/);
  assert.match(client, /\[404, 405, 501\]/);
  assert.match(audit.mode_contract.static, /must not simulate shared mutation/);
  assert.match(audit.release_rule, /exact operation and HTTP method/);
});
