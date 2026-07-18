import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyHostedBackup } from '../archie-hosted-backup.mjs';
import { tokenSha256 } from '../archie-hosted-security.mjs';
import {
  ARCHIED_HOSTED_MIGRATION_LEVEL,
  ARCHIED_HOSTED_VERSION,
  resolveHostedConfig,
  startHostedArchied
} from '../archied-hosted.mjs';

const founderToken = 'founder-token-0123456789-archie-hosted';
const developerToken = 'developer-token-0123456789-archie-hosted';
const objective = 'Make this hosted workflow genuinely good on a phone while preserving explicit human control.';
const requestedChange = 'Preserve the final audit trail and why the alternative product hypothesis was rejected.';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function login(baseUrl, token) {
  const response = await fetch(new URL('login', baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, return_to: '/' })
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

function options(home, keys) {
  return {
    home,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://archie.test/',
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    sessionKey: keys.session,
    secretKey: keys.secret,
    allowInsecure: true,
    env: {}
  };
}

test('hosted Archie preserves founder/developer grants, shares, encrypted secrets, backups, and restart state', async t => {
  const home = await tempRoot(t, 'archie-hosted-authority-');
  const keys = {
    session: crypto.randomBytes(32).toString('base64'),
    secret: crypto.randomBytes(32).toString('base64')
  };
  const first = await startHostedArchied(options(home, keys));
  t.after(() => first.close().catch(() => {}));

  const health = await fetch(new URL('health', first.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    schema: 'archied-health/v1',
    status: 'ok',
    mode: 'hosted',
    service_version: ARCHIED_HOSTED_VERSION,
    migration_level: ARCHIED_HOSTED_MIGRATION_LEVEL
  });

  const anonymous = await fetch(first.url, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get('location'), /^\/login\?return_to=/);
  assert.equal((await fetch(new URL('v1/hosted/status', first.url))).status, 401);

  const rejected = await login(first.url, 'wrong-private-token');
  assert.equal(rejected.response.status, 401);
  const founder = await login(first.url, founderToken);
  const developer = await login(first.url, developerToken);
  for (const session of [founder, developer]) {
    assert.equal(session.response.status, 303);
    assert.match(session.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(session.response.headers.get('set-cookie'), /SameSite=Strict/);
    assert.ok(session.cookie.startsWith('archie_hosted_session='));
  }

  const descriptorResponse = await fetch(new URL('.well-known/archied.json', first.url), { headers: { cookie: founder.cookie } });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.schema, 'archied-hosted-runtime/v1');
  assert.equal(descriptor.base_url, 'http://archie.test/');
  assert.equal(decodeURI(descriptor.workspace_url_template), 'http://archie.test/w/{workspace_id}');
  assert.equal(descriptor.authentication.developer_enabled, true);
  assert.equal(descriptor.github_required, false);
  assert.equal(descriptor.vendor_specific_dependency, false);
  for (const secret of [home, founderToken, developerToken, keys.secret]) {
    assert.equal(JSON.stringify(descriptor).includes(secret), false);
  }

  const developerJourney = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: developer.cookie },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(developerJourney.status, 403);

  const journeyResponse = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(journeyResponse.status, 201);
  const journey = await journeyResponse.json();
  assert.match(journey.workspace_id, /^workspace_[a-f0-9]{16}$/);
  assert.equal('bundle_path' in journey, false);

  const stablePage = await fetch(new URL(`w/${journey.workspace_id}`, first.url), {
    headers: { cookie: founder.cookie, accept: 'text/html' }
  });
  assert.equal(stablePage.status, 200);
  assert.match(await stablePage.text(), /State what should be true/);
  const developerDenied = await fetch(new URL(`v1/workspaces/${journey.workspace_id}`, first.url), { headers: { cookie: developer.cookie } });
  assert.equal(developerDenied.status, 403);

  await first.internal.engine.execute(journey.workspace_id, 'owner_local', 'agent.register', {
    agent_id: 'developer_local', label: 'Hosted developer', kind: 'human'
  });
  await first.internal.engine.execute(journey.workspace_id, 'owner_local', 'grant.issue', {
    grant_id: 'grant_developer_read', principal_id: 'developer_local', capabilities: ['read']
  });
  const developerAllowed = await fetch(new URL(`v1/workspaces/${journey.workspace_id}`, first.url), { headers: { cookie: developer.cookie } });
  assert.equal(developerAllowed.status, 200);

  const shareResponse = await fetch(new URL('v1/hosted/shares', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ workspace_id: journey.workspace_id, expires_in_ms: 3_600_000, label: 'Review-only evidence share' })
  });
  assert.equal(shareResponse.status, 201);
  const share = await shareResponse.json();
  assert.deepEqual(share.capabilities, ['read']);
  assert.equal(share.token_disclosed_once, true);
  const shareToken = new URL(share.share_url).pathname.split('/').at(-1);
  const sharedResponse = await fetch(new URL(`share/${shareToken}`, first.url));
  assert.equal(sharedResponse.status, 200);
  const shared = await sharedResponse.json();
  assert.equal(shared.workspace.workspace_id, journey.workspace_id);
  assert.deepEqual(shared.share.capabilities, ['read']);
  assert.equal(JSON.stringify(shared).includes(shareToken), false);
  assert.equal((await fetch(new URL(`share/${shareToken}`, first.url), { method: 'POST' })).status, 401);

  const shareList = await fetch(new URL(`v1/hosted/workspaces/${journey.workspace_id}/shares`, first.url), {
    headers: { cookie: founder.cookie }
  }).then(response => response.json());
  assert.equal(shareList.shares[0].share_id, share.share_id);
  assert.equal(JSON.stringify(shareList).includes(shareToken), false);

  const deniedSecret = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: developer.cookie },
    body: JSON.stringify({ value: 'must-not-be-written' })
  });
  assert.equal(deniedSecret.status, 403);

  const plaintext = 'private-provider-secret-value';
  const secretResponse = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ value: plaintext })
  });
  assert.equal(secretResponse.status, 200);
  const encryptedText = await fs.readFile(path.join(first.data_root, 'hosted', 'secrets.enc.json'), 'utf8');
  assert.equal(encryptedText.includes(plaintext), false);
  assert.match(encryptedText, /aes-256-gcm/);

  const developerStatus = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: developer.cookie } }).then(response => response.json());
  assert.equal(developerStatus.workspaces.count, 1);
  assert.equal(developerStatus.secrets.configured_count, 1);
  assert.equal('secrets' in developerStatus.secrets, false);
  const founderStatus = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: founder.cookie } }).then(response => response.json());
  assert.equal(founderStatus.workspaces.count, 1);
  assert.deepEqual(founderStatus.secrets.secrets.map(item => item.name), ['provider_api']);

  assert.equal((await fetch(new URL('v1/hosted/backups', first.url), { method: 'POST', headers: { cookie: developer.cookie } })).status, 403);
  const backupResponse = await fetch(new URL('v1/hosted/backups', first.url), { method: 'POST', headers: { cookie: founder.cookie } });
  assert.equal(backupResponse.status, 201);
  const backupReceipt = await backupResponse.json();
  assert.equal(backupReceipt.workspace_count, 1);
  assert.equal(backupReceipt.artifact_count, 2);
  const backupNames = await fs.readdir(path.join(first.data_root, 'backups'));
  const backupText = await fs.readFile(path.join(first.data_root, 'backups', backupNames[0]), 'utf8');
  for (const secret of [plaintext, founderToken, developerToken, keys.secret]) assert.equal(backupText.includes(secret), false);
  const backup = verifyHostedBackup(JSON.parse(backupText));
  assert.equal(backup.backup_digest, backupReceipt.backup_digest);
  assert.equal(backup.encrypted_secrets.schema, 'archie-encrypted-secret-store/v1');

  const revokeResponse = await fetch(new URL(`v1/hosted/workspaces/${journey.workspace_id}/shares/${share.share_id}/revoke`, first.url), {
    method: 'POST', headers: { cookie: founder.cookie }
  });
  assert.equal(revokeResponse.status, 200);
  assert.equal((await fetch(new URL(`share/${shareToken}`, first.url))).status, 403);

  const finalState = await fetch(new URL(`v1/workspaces/${journey.workspace_id}`, first.url), { headers: { cookie: founder.cookie } }).then(response => response.json());
  await first.close();
  const restarted = await startHostedArchied(options(home, keys));
  t.after(() => restarted.close().catch(() => {}));
  const nextFounder = await login(restarted.url, founderToken);
  const restartedStatus = await fetch(new URL('v1/hosted/status', restarted.url), { headers: { cookie: nextFounder.cookie } }).then(response => response.json());
  assert.equal(restartedStatus.workspaces.items[0].head_digest, finalState.head_digest);
  assert.equal(restartedStatus.secrets.configured_count, 1);
  assert.equal(restartedStatus.backups.backup_count, 1);
  assert.equal(restartedStatus.shares.share_count, 1);
});

test('hosted configuration fails closed while preserving the in-process hybrid compatibility path', () => {
  const common = {
    ARCHIED_FOUNDER_TOKEN_SHA256: tokenSha256(founderToken),
    ARCHIED_DEVELOPER_TOKEN_SHA256: tokenSha256(developerToken),
    ARCHIED_SESSION_KEY: crypto.randomBytes(32).toString('base64'),
    ARCHIED_SECRET_KEY: crypto.randomBytes(32).toString('base64')
  };
  assert.throws(() => resolveHostedConfig({ env: common }), /absolute URL/);
  assert.throws(() => resolveHostedConfig({ env: { ...common, ARCHIED_PUBLIC_URL: 'http://archie.test/' } }), /requires an HTTPS/);
  const config = resolveHostedConfig({
    env: { ...common, ARCHIED_PUBLIC_URL: 'http://archie.test/', ARCHIED_ALLOW_INSECURE_HOSTED: '1' },
    port: 0
  });
  assert.equal(config.public_url, 'http://archie.test/');
  assert.equal(config.legacy_founder_only, false);

  const legacy = resolveHostedConfig({
    token: founderToken,
    publicOrigin: 'http://127.0.0.1:8787',
    port: 0,
    env: { ARCHIED_COOKIE_SECURE: 'false' }
  });
  assert.equal(legacy.legacy_founder_only, true);
  assert.equal(legacy.founder_token_sha256, tokenSha256(founderToken));
  assert.match(legacy.session_key, /^[A-Za-z0-9+/]+=*$/);
  assert.match(legacy.secret_key, /^[A-Za-z0-9+/]+=*$/);
});

test('hosted authority stack is non-root, provider-neutral, and digest-configured', async () => {
  const dockerfile = await fs.readFile(new URL('../../Dockerfile.archie', import.meta.url), 'utf8');
  const compose = await fs.readFile(new URL('../../compose.hosted.yaml', import.meta.url), 'utf8');
  const example = await fs.readFile(new URL('../../.env.archied.example', import.meta.url), 'utf8');
  const documentation = await fs.readFile(new URL('../../ARCHIE_HOSTED.md', import.meta.url), 'utf8');
  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /curl|wget|git clone/i);
  assert.match(compose, /command: \["node", "scripts\/archied-hosted\.mjs"\]/);
  assert.match(compose, /env_file:/);
  assert.match(compose, /archie-data:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /127\.0\.0\.1/);
  assert.match(example, /ARCHIED_FOUNDER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_DEVELOPER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_SESSION_KEY/);
  assert.match(example, /ARCHIED_SECRET_KEY/);
  assert.match(documentation, /without buying or creating an external service|does not buy or create an external service/i);
  assert.match(documentation, /Hard boundary/);
});
