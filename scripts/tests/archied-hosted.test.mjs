import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startHostedArchied } from '../archied-hosted.mjs';
import { verifyWorkspaceBundle } from '../archie-workspace-portable.mjs';

const token = 'archie-founder-test-token-0123456789abcdef';
const objective = 'Make this local workflow genuinely good on a phone while reducing work and preserving human control.';
const requestedChange = 'Add the final audit trail and preserve why the alternative hypothesis lost.';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function login(baseUrl, suppliedToken = token, returnTo = '/') {
  const response = await fetch(new URL('/login', baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: suppliedToken, return_to: returnTo })
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

test('hosted Archie protects the same product and preserves workspace state across restart', async t => {
  const home = await tempRoot(t, 'archie-hosted-');
  const first = await startHostedArchied({ home, token, host: '127.0.0.1', port: 0, env: {} });
  t.after(() => first.close().catch(() => {}));

  const health = await fetch(new URL('/health', first.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    schema: 'archied-health/v1',
    status: 'ok',
    mode: 'hosted',
    service_version: '0.1.0',
    migration_level: 1
  });

  const anonymous = await fetch(first.url, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get('location'), /^\/login\?return_to=/);

  const deniedApi = await fetch(new URL('/v1/hosted/status', first.url));
  assert.equal(deniedApi.status, 401);
  assert.equal((await deniedApi.json()).error, 'authentication_required');

  const rejected = await login(first.url, 'wrong-token-value-that-is-long-enough');
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.cookie, '');

  const authenticated = await login(first.url);
  assert.equal(authenticated.response.status, 303);
  assert.equal(authenticated.response.headers.get('location'), '/');
  assert.match(authenticated.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(authenticated.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(authenticated.cookie.startsWith('archie_founder_session='));

  const product = await fetch(first.url, { headers: { accept: 'text/html', cookie: authenticated.cookie } });
  assert.equal(product.status, 200);
  const client = await product.text();
  assert.match(client, /State what should be true/);
  assert.match(client, /Run bounded local journey/);

  const descriptorResponse = await fetch(new URL('/.well-known/archied.json', first.url), {
    headers: { cookie: authenticated.cookie }
  });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.schema, 'archied-hosted-runtime/v1');
  assert.equal(descriptor.mode, 'hosted');
  assert.equal(descriptor.github_required, false);
  assert.equal(descriptor.local_runner_inbound_access_required, false);
  assert.equal(JSON.stringify(descriptor).includes(token), false);
  assert.equal(JSON.stringify(descriptor).includes(home), false);

  const journeyResponse = await fetch(new URL('/v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authenticated.cookie },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(journeyResponse.status, 201);
  const journey = await journeyResponse.json();
  assert.match(journey.workspace_id, /^workspace_[a-f0-9]{16}$/);
  assert.match(journey.bundle_digest, /^[a-f0-9]{64}$/);
  assert.equal('bundle_path' in journey, false);

  const statusResponse = await fetch(new URL('/v1/hosted/status', first.url), {
    headers: { cookie: authenticated.cookie }
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.schema, 'archied-hosted-status/v1');
  assert.equal(status.workspace_count, 1);
  assert.equal(status.portable_backup_ready, true);
  assert.equal(status.workspaces[0].workspace_id, journey.workspace_id);
  assert.equal(status.workspaces[0].rollback_count, 1);
  assert.match(status.workspaces[0].export_url, /\/export$/);

  const exportResponse = await fetch(status.workspaces[0].export_url, {
    headers: { cookie: authenticated.cookie }
  });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('x-archie-bundle-digest'), journey.bundle_digest);
  const bundle = await exportResponse.json();
  assert.equal(verifyWorkspaceBundle(bundle).bundle_digest, journey.bundle_digest);
  assert.equal(JSON.stringify(bundle).includes(home), false);

  await first.close();
  const restarted = await startHostedArchied({ home, token, host: '127.0.0.1', port: 0, env: {} });
  t.after(() => restarted.close().catch(() => {}));
  const nextSession = await login(restarted.url);
  assert.equal(nextSession.response.status, 303);
  const afterRestart = await fetch(new URL('/v1/hosted/status', restarted.url), {
    headers: { cookie: nextSession.cookie }
  });
  assert.equal(afterRestart.status, 200);
  const restoredStatus = await afterRestart.json();
  assert.equal(restoredStatus.workspace_count, 1);
  assert.equal(restoredStatus.workspaces[0].workspace_id, journey.workspace_id);
  assert.equal(restoredStatus.workspaces[0].head_digest, journey.head_digest);
});

test('hosted Archie fails closed without a strong founder token', async () => {
  await assert.rejects(
    startHostedArchied({ token: 'too-short', host: '127.0.0.1', port: 0, env: {} }),
    /at least 24 characters/
  );
});

test('container contract runs one non-root service with durable data and mandatory private access', async () => {
  const dockerfile = await fs.readFile(new URL('../../Dockerfile.archie', import.meta.url), 'utf8');
  const compose = await fs.readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const ignore = await fs.readFile(new URL('../../.dockerignore', import.meta.url), 'utf8');

  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /archied-hosted\.mjs/);
  assert.doesNotMatch(dockerfile, /curl|wget|git clone/i);

  assert.match(compose, /ARCHIED_FOUNDER_TOKEN: \$\{ARCHIED_FOUNDER_TOKEN:\?/);
  assert.match(compose, /archie-data:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /healthcheck:/);

  assert.match(ignore, /\.git/);
  assert.match(ignore, /node_modules/);
});
