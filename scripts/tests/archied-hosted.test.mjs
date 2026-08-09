import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EncryptedSecretStore,
  HostedShareRegistry,
  tokenSha256
} from '../archie-hosted-security.mjs';
import {
  ARCHIED_HOSTED_MIGRATION_LEVEL,
  ARCHIED_HOSTED_VERSION,
  resolveHostedConfig,
  startHostedArchied
} from '../archied-hosted.mjs';

const founderToken = 'founder-token-0123456789-archie-hosted';
const developerToken = 'developer-token-0123456789-archie-hosted';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function login(baseUrl, token) {
  const response = await fetch(new URL('login', baseUrl), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, return_to: '/' })
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

function options(home, keys) {
  return {
    home, host: '127.0.0.1', port: 0,
    publicUrl: 'http://archie.test/',
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    sessionKey: keys.session,
    secretKey: keys.secret,
    allowInsecure: true,
    env: {}
  };
}

test('hosted service separates founder/developer access and persists encrypted state', async t => {
  const home = await tempRoot(t, 'archie-hosted-');
  const keys = { session: crypto.randomBytes(32).toString('base64'), secret: crypto.randomBytes(32).toString('base64') };
  const first = await startHostedArchied(options(home, keys));
  t.after(() => first.close().catch(() => {}));

  const health = await fetch(new URL('health', first.url)).then(response => response.json());
  assert.deepEqual(health, {
    schema: 'archied-health/v1', status: 'ok', mode: 'hosted',
    service_version: ARCHIED_HOSTED_VERSION, migration_level: ARCHIED_HOSTED_MIGRATION_LEVEL
  });
  assert.equal((await fetch(new URL('v1/hosted/status', first.url))).status, 401);

  const founder = await login(first.url, founderToken);
  const developer = await login(first.url, developerToken);
  assert.equal(founder.response.status, 303);
  assert.equal(developer.response.status, 303);
  assert.match(founder.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(founder.response.headers.get('set-cookie'), /SameSite=Strict/);

  const descriptor = await fetch(new URL('.well-known/archied.json', first.url), { headers: { cookie: founder.cookie } }).then(r => r.json());
  assert.equal(descriptor.schema, 'archied-hosted-runtime/v1');
  assert.equal(descriptor.authentication.developer_enabled, true);
  assert.equal(descriptor.github_required, false);
  assert.equal(descriptor.local_runner_inbound_access_required, false);
  assert.equal(JSON.stringify(descriptor).includes(founderToken), false);
  assert.equal(JSON.stringify(descriptor).includes(keys.secret), false);

  const deniedSecret = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: developer.cookie },
    body: JSON.stringify({ value: 'must-not-write' })
  });
  assert.equal(deniedSecret.status, 403);

  const plaintext = 'private-provider-secret-value';
  const stored = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ value: plaintext })
  });
  assert.equal(stored.status, 200);
  const encryptedPath = path.join(first.data_root, 'hosted', 'secrets.enc.json');
  const encrypted = await fs.readFile(encryptedPath, 'utf8');
  assert.equal(encrypted.includes(plaintext), false);
  assert.match(encrypted, /aes-256-gcm/);

  const founderStatus = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: founder.cookie } }).then(r => r.json());
  const developerStatus = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: developer.cookie } }).then(r => r.json());
  assert.deepEqual(founderStatus.secrets.secrets.map(item => item.name), ['provider_api']);
  assert.equal('secrets' in developerStatus.secrets, false);

  await first.close();
  const restarted = await startHostedArchied(options(home, keys));
  t.after(() => restarted.close().catch(() => {}));
  const nextFounder = await login(restarted.url, founderToken);
  const afterRestart = await fetch(new URL('v1/hosted/status', restarted.url), { headers: { cookie: nextFounder.cookie } }).then(r => r.json());
  assert.equal(afterRestart.secrets.configured_count, 1);
});

test('share and secret registries serialize concurrent mutations instead of losing updates', async t => {
  const root = await tempRoot(t, 'archie-hosted-registry-');
  const shares = new HostedShareRegistry(root);
  await Promise.all([
    shares.issue({ workspaceId: 'workspace_one', principalId: 'viewer_one', grantId: 'grant_one', createdBy: 'owner_local', expiresInMs: 60_000 }),
    shares.issue({ workspaceId: 'workspace_one', principalId: 'viewer_two', grantId: 'grant_two', createdBy: 'owner_local', expiresInMs: 60_000 })
  ]);
  assert.equal((await shares.status()).share_count, 2);
  assert.equal((await shares.list('workspace_one')).length, 2);

  const secrets = new EncryptedSecretStore(path.join(root, 'secrets.enc.json'), crypto.randomBytes(32).toString('base64'));
  await Promise.all([
    secrets.set('first_secret', 'alpha'),
    secrets.set('second_secret', 'beta')
  ]);
  assert.equal((await secrets.status()).configured_count, 2);
  const raw = await fs.readFile(path.join(root, 'secrets.enc.json'), 'utf8');
  assert.equal(raw.includes('alpha'), false);
  assert.equal(raw.includes('beta'), false);
});

test('hosted configuration fails closed and legacy single-token compatibility remains explicit', () => {
  const common = {
    ARCHIED_FOUNDER_TOKEN_SHA256: tokenSha256(founderToken),
    ARCHIED_DEVELOPER_TOKEN_SHA256: tokenSha256(developerToken),
    ARCHIED_SESSION_KEY: crypto.randomBytes(32).toString('base64'),
    ARCHIED_SECRET_KEY: crypto.randomBytes(32).toString('base64')
  };
  assert.throws(() => resolveHostedConfig({ env: common }), /absolute URL/);
  assert.throws(() => resolveHostedConfig({ env: { ...common, ARCHIED_PUBLIC_URL: 'http://archie.test/' } }), /requires an HTTPS/);

  const legacy = resolveHostedConfig({
    token: founderToken,
    publicOrigin: 'http://127.0.0.1:8787', port: 0,
    env: { ARCHIED_COOKIE_SECURE: 'false' }
  });
  assert.equal(legacy.legacy_founder_only, true);
  assert.equal(legacy.founder_token_sha256, tokenSha256(founderToken));
});

test('container contract references only retained hosted files and runs non-root', async () => {
  const dockerfile = await fs.readFile(new URL('../../Dockerfile.archie', import.meta.url), 'utf8');
  const compose = await fs.readFile(new URL('../../compose.hosted.yaml', import.meta.url), 'utf8');
  const example = await fs.readFile(new URL('../../.env.archied.example', import.meta.url), 'utf8');

  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /scripts\/archied-hosted\.mjs/);
  assert.doesNotMatch(dockerfile, /archie-hybrid-runner\.mjs/);
  assert.match(compose, /archie-local\/archied-hosted:0\.5\.3/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /127\.0\.0\.1/);
  for (const key of ['ARCHIED_FOUNDER_TOKEN_SHA256', 'ARCHIED_DEVELOPER_TOKEN_SHA256', 'ARCHIED_SESSION_KEY', 'ARCHIED_SECRET_KEY']) {
    assert.match(example, new RegExp(key));
  }
});
