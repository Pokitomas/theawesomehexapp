import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIED_MIGRATION_LEVEL,
  ARCHIED_RUNTIME_SCHEMA,
  resolveArchiedConfig,
  startArchied
} from '../archied.mjs';

test('archied resolves durable state outside the repository without source-host configuration', () => {
  const home = path.join(os.tmpdir(), 'archie-config-home');
  const config = resolveArchiedConfig({
    argv: ['--dev', '--port', '0'],
    env: {
      ARCHIE_HOME: home,
      GITHUB_TOKEN: 'must-not-be-read',
      GITHUB_REPOSITORY: 'must/not-be-canonical'
    }
  });
  assert.equal(config.mode, 'development');
  assert.equal(config.port, 0);
  assert.equal(config.root, path.join(home, 'standalone', 'workspaces'));
  assert.equal(JSON.stringify(config).toLowerCase().includes('github'), false);
});

test('archied persists a private workspace across restart with no GitHub identity or network dependency', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'archied-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const first = await startArchied({ home, host: '127.0.0.1', port: 0 });
  const health = await fetch(new URL('health', first.url)).then(response => response.json());
  assert.equal(health.schema, ARCHIED_RUNTIME_SCHEMA);
  assert.equal(health.migration_level, ARCHIED_MIGRATION_LEVEL);
  assert.equal(health.github_required, false);
  assert.equal(health.source_host_required, false);
  assert.equal(health.network_required_after_install, false);
  assert.equal(JSON.stringify(health).toLowerCase().includes('github.com'), false);
  assert.equal(first.root, path.join(home, 'standalone', 'workspaces'));

  const createResponse = await fetch(new URL('v1/workspaces', first.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-archie-principal': 'owner_local'
    },
    body: JSON.stringify({
      workspace_id: 'workspace_standalone',
      title: 'Standalone durable workspace',
      visibility: 'private'
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.workspace.owner_id, 'owner_local');
  await first.close();

  const restarted = await startArchied({ home, host: '127.0.0.1', port: 0 });
  t.after(() => restarted.close().catch(() => {}));
  const inspectResponse = await fetch(new URL('v1/workspaces/workspace_standalone', restarted.url), {
    headers: { 'x-archie-principal': 'owner_local' }
  });
  assert.equal(inspectResponse.status, 200);
  const state = await inspectResponse.json();
  assert.equal(state.workspace.workspace_id, 'workspace_standalone');
  assert.equal(state.workspace.visibility, 'private');
  assert.match(state.head_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(state).toLowerCase().includes('github'), false);
});

test('archied rejects invalid ports before opening a service', () => {
  assert.throws(
    () => resolveArchiedConfig({ argv: ['--port', '70000'], env: {} }),
    /--port must be an integer/
  );
});
