import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/social-product-reachability.json'));
const clientPaths = [audit.consumer_client, ...(audit.consumer_client_extensions || [])];
const clientSources = Object.fromEntries(await Promise.all(clientPaths.map(async path => [path, await read(path)])));
const client = Object.values(clientSources).join('\n');
const server = await read(audit.relational_service);
const governance = clientSources['studio/manual/product/social-governance-controls.js'];

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const operationRegistry = Object.fromEntries(
  [...governance.matchAll(/^\s{2}(['"]?)([a-z-]+)\1:\s*Object\.freeze\(\[([^\]]+)\]\)/gm)]
    .map(([, , op, methods]) => [op, [...methods.matchAll(/['"]([A-Z]+)['"]/g)].map(match => match[1])])
);

function parts(operation) {
  const [op, method] = operation.split(':');
  assert.ok(op && method, `operation must be method-qualified: ${operation}`);
  return { op, method: method.toUpperCase() };
}

function serverHas(operation) {
  const { op, method } = parts(operation);
  if (method === 'GET' && ['discover', 'feed'].includes(op)) return server.includes("request.method === 'GET' && (op === 'discover' || op === 'feed')");
  return new RegExp(`request\\.method === '${method}' && op === '${escape(op)}'`).test(server);
}

function baseClientHas(operation) {
  const { op, method } = parts(operation);
  if (method === 'POST' && ['register', 'login'].includes(op)) return client.includes("request(register ? 'register' : 'login'") && client.includes("method: 'POST'");
  if (method === 'GET' && ['discover', 'feed'].includes(op)) return client.includes("requestedMode === 'following' ? 'feed' : 'discover'");
  if (method === 'POST' && op === 'post-state') return client.includes("fetch(`${API}?op=post-state`") && client.includes("method: 'POST'") && client.includes('JSON.stringify({ postId, active: false })');
  const direct = new RegExp(`request\\(['"]${escape(op)}['"]\\s*(?:,\\s*\\{([\\s\\S]{0,500}?))?\\)`, 'g');
  return [...client.matchAll(direct)].some(match => {
    const options = match[1] || '';
    if (method === 'GET') return !/method:\s*['"]/.test(options);
    return new RegExp(`method:\\s*['"]${method}['"]`).test(options);
  });
}

function clientHas(operation) {
  const { op, method } = parts(operation);
  return baseClientHas(operation) || Boolean(operationRegistry[op]?.includes(method));
}

test('every declared consumer capability is admitted by the relational service with the same exact method', () => {
  for (const operation of audit.visible_operations) {
    assert.ok(clientHas(operation), `client does not expose ${operation}`);
    assert.ok(serverHas(operation), `server does not admit ${operation}`);
  }
  assert.deepEqual(audit.server_only_operations, []);
  assert.deepEqual(audit.highest_priority_gaps, []);
});

test('governance client binds every server-only operation to an explicit method registry', () => {
  const expected = {
    community: ['GET', 'POST'],
    'community-member': ['POST'],
    'community-role': ['POST'],
    'community-fork': ['POST'],
    'community-feed': ['GET'],
    thread: ['GET'],
    post: ['POST', 'PATCH'],
    report: ['POST'],
    moderate: ['POST'],
    appeal: ['POST'],
    'appeal-decide': ['POST'],
    'local-control': ['POST']
  };
  assert.deepEqual(operationRegistry, expected);
  assert.match(governance, /if \(declared && !declared\.includes\(method\)\) throw new Error/);
  assert.match(governance, /headers\['idempotency-key'\] = idempotencyKey\(op\)/);
});

test('dangerous controls are absent unless returned membership proves authority', () => {
  assert.match(governance, /if \(!\['moderator', 'owner'\]\.includes\(role\)\) return/);
  assert.match(governance, /if \(role !== 'owner'\) return/);
  assert.match(governance, /membership\?\.status === 'active'/);
  assert.doesNotMatch(governance, /disabled[^\n]+moderate|disabled[^\n]+appeal-decide/);
});

test('public authority remains separate from private archive state', () => {
  assert.match(governance, /private archive.*will not be changed/i);
  assert.match(governance, /Private archive unchanged/);
  assert.match(audit.archive_separation, /never delete or rewrite a private archive record/);
  for (const forbidden of ['Workspace.deleteRecord', 'indexedDB.deleteDatabase', 'localStorage.removeItem', 'openCorpusDB']) assert.ok(!governance.includes(forbidden), `governance client contains ${forbidden}`);
});

test('static and Blob-only operation failures are explicit and never optimistic', () => {
  assert.match(governance, /RELATIONAL_UNAVAILABLE = new Set\(\[404, 405, 501\]\)/);
  assert.match(governance, /No shared change was simulated/);
  assert.match(governance, /if \(result\) await openThread/);
  assert.match(audit.mode_contract.static, /never simulated/);
  assert.match(audit.mode_contract.blob, /fail visibly as unavailable/);
});
