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

async function login(baseUrl, token, returnTo = '/') {
  const response = await fetch(new URL('login', baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, return_to: returnTo })
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

test('hosted Archie protects one product and preserves exact state across restart', async t => {
  const home = await tempRoot(t, 'archie-hosted-parity-');
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
  const deniedStatus = await fetch(new URL('v1/hosted/status', first.url));
  assert.equal(deniedStatus.status, 401);
  assert.equal((await deniedStatus.json()).error, 'authentication_required');

  const rejected = await login(first.url, 'wrong-private-token');
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.cookie, '');

  const founder = await login(first.url, founderToken);
  assert.equal(founder.response.status, 303);
  assert.match(founder.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(founder.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(founder.cookie.startsWith('archie_hosted_session='));
  const developer = await login(first.url, developerToken);
  assert.equal(developer.response.status, 303);
  assert.ok(developer.cookie.startsWith('archie_hosted_session='));

  const founderProduct = await fetch(first.url, { headers: { accept: 'text/html', cookie: founder.cookie } });
  assert.equal(founderProduct.status, 200);
  assert.match(await founderProduct.text(), /State what should be true/);
  const developerProduct = await fetch(first.url, { headers: { accept: 'text/html', cookie: developer.cookie } });
  assert.equal(developerProduct.status, 200);

  const descriptorResponse = await fetch(new URL('.well-known/archied.json', first.url), { headers: { cookie: founder.cookie } });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.schema, 'archied-hosted-runtime/v1');
  assert.equal(descriptor.mode, 'hosted');
  assert.equal(descriptor.base_url, 'http://archie.test/');
  assert.equal(descriptor.workspace_url_template, 'http://archie.test/w/{workspace_id}');
  assert.equal(descriptor.github_required, false);
  assert.equal(descriptor.vendor_specific_dependency, false);
  assert.equal(descriptor.local_runner_inbound_access_required, false);
  assert.equal(JSON.stringify(descriptor).includes(home), false);
  assert.equal(JSON.stringify(descriptor).includes(founderToken), false);
  assert.equal(JSON.stringify(descriptor).includes(keys.secret), false);

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
  assert.match(journey.bundle_digest, /^[a-f0-9]{64}$/);
  assert.equal('bundle_path' in journey, false);

  const founderWorkspace = await fetch(new URL(`w/${journey.workspace_id}`, first.url), { headers: { cookie: founder.cookie } });
  assert.equal(founderWorkspace.status, 200);
  assert.equal((await founderWorkspace.json()).head_digest, journey.head_digest);
  const developerWorkspace = await fetch(new URL(`w/${journey.workspace_id}`, first.url), { headers: { cookie: developer.cookie } });
  assert.equal(developerWorkspace.status, 403);

  const shareResponse = await fetch(new URL('v1/hosted/shares', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ workspace_id: journey.workspace_id, expires_in_ms: 3_600_000, label: 'Review-only evidence share' })
  });
  assert.equal(shareResponse.status, 201);
  const share = await shareResponse.json();
  assert.deepEqual(share.capabilities, ['read']);
  assert.equal(share.token_disclosed_once, true);
  assert.match(share.share_url, /^http:\/\/archie\.test\/share\//);
  const shareToken = new URL(share.share_url).pathname.split('/').at(-1);
  assert.ok(shareToken.length >= 32);

  const anonymousShare = await fetch(new URL(`share/${shareToken}`, first.url));
  assert.equal(anonymousShare.status, 200);
  const shared = await anonymousShare.json();
  assert.equal(shared.schema, 'archie-hosted-read-share/v1');
  assert.equal(shared.workspace.workspace_id, journey.workspace_id);
  assert.equal(shared.workspace.head_digest, journey.head_digest);
  assert.deepEqual(shared.share.capabilities, ['read']);
  assert.equal(JSON.stringify(shared).includes(shareToken), false);

  const shareMutation = await fetch(new URL(`share/${shareToken}`, first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'grant.issue' })
  });
  assert.equal(shareMutation.status, 401);

  const shareListResponse = await fetch(new URL(`v1/hosted/workspaces/${journey.workspace_id}/shares`, first.url), { headers: { cookie: founder.cookie } });
  assert.equal(shareListResponse.status, 200);
  const shareList = await shareListResponse.json();
  assert.equal(shareList.shares.length, 1);
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
  const secretReceipt = await secretResponse.json();
  assert.equal(secretReceipt.secret.name, 'provider_api');
  assert.equal('value' in secretReceipt.secret, false);
  const encryptedPath = path.join(first.data_root, 'hosted', 'secrets.enc.json');
  const encryptedText = await fs.readFile(encryptedPath, 'utf8');
  assert.equal(encryptedText.includes(plaintext), false);
  assert.match(encryptedText, /aes-256-gcm/);

  const developerStatusResponse = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: developer.cookie } });
  assert.equal(developerStatusResponse.status, 200);
  const developerStatus = await developerStatusResponse.json();
  assert.equal(developerStatus.principal.role, 'developer');
  assert.equal(developerStatus.workspaces.count, 0);
  assert.equal(developerStatus.secrets.configured_count, 1);
  assert.equal('secrets' in developerStatus.secrets, false);
  assert.equal(JSON.stringify(developerStatus).includes(plaintext), false);

  const founderStatusResponse = await fetch(new URL('v1/hosted/status', first.url), { headers: { cookie: founder.cookie } });
  assert.equal(founderStatusResponse.status, 200);
  const founderStatus = await founderStatusResponse.json();
  assert.equal(founderStatus.principal.role, 'founder');
  assert.equal(founderStatus.workspaces.count, 1);
  assert.equal(founderStatus.workspaces.items[0].workspace_id, journey.workspace_id);
  assert.deepEqual(founderStatus.secrets.secrets.map(item => item.name), ['provider_api']);
  assert.equal(founderStatus.backups.backup_count, 0);
  assert.equal(JSON.stringify(founderStatus).includes(plaintext), false);

  const deniedBackup = await fetch(new URL('v1/hosted/backups', first.url), { method: 'POST', headers: { cookie: developer.cookie } });
  assert.equal(deniedBackup.status, 403);
  const backupResponse = await fetch(new URL('v1/hosted/backups', first.url), { method: 'POST', headers: { cookie: founder.cookie } });
  assert.equal(backupResponse.status, 201);
  const backupReceipt = await backupResponse.json();
  assert.match(backupReceipt.backup_digest, /^[a-f0-9]{64}$/);
  assert.equal(backupReceipt.workspace_count, 1);
  assert.equal(backupReceipt.artifact_count, 2);

  const backupNames = await fs.readdir(path.join(first.data_root, 'backups'));
  assert.equal(backupNames.length, 1);
  const backupText = await fs.readFile(path.join(first.data_root, 'backups', backupNames[0]), 'utf8');
  assert.equal(backupText.includes(plaintext), false);
  assert.equal(backupText.includes(founderToken), false);
  assert.equal(backupText.includes(keys.secret), false);
  const backup = verifyHostedBackup(JSON.parse(backupText));
  assert.equal(backup.backup_digest, backupReceipt.backup_digest);
  assert.equal(backup.encrypted_secrets.schema, 'archie-encrypted-secret-store/v1');
  assert.equal('key' in backup.encrypted_secrets, false);

  const secondShareResponse = await fetch(new URL('v1/hosted/shares', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: founder.cookie },
    body: JSON.stringify({ workspace_id: journey.workspace_id, expires_in_ms: 3_600_000 })
  });
  assert.equal(secondShareResponse.status, 201);
  const secondShare = await secondShareResponse.json();
  const secondShareToken = new URL(secondShare.share_url).pathname.split('/').at(-1);

  const revokeResponse = await fetch(new URL(`v1/hosted/workspaces/${journey.workspace_id}/shares/${share.share_id}/revoke`, first.url), {
    method: 'POST',
    headers: { cookie: founder.cookie }
  });
  assert.equal(revokeResponse.status, 200);
  const revokedShare = await fetch(new URL(`share/${shareToken}`, first.url));
  assert.equal(revokedShare.status, 403);

  const finalFounderState = await fetch(new URL(`w/${journey.workspace_id}`, first.url), { headers: { cookie: founder.cookie } });
  const finalHead = (await finalFounderState.json()).head_digest;
  await first.close();

  const restarted = await startHostedArchied(options(home, keys));
  t.after(() => restarted.close().catch(() => {}));
  const nextFounder = await login(restarted.url, founderToken);
  assert.equal(nextFounder.response.status, 303);
  const restartedStatusResponse = await fetch(new URL('v1/hosted/status', restarted.url), { headers: { cookie: nextFounder.cookie } });
  assert.equal(restartedStatusResponse.status, 200);
  const restartedStatus = await restartedStatusResponse.json();
  assert.equal(restartedStatus.workspaces.count, 1);
  assert.equal(restartedStatus.workspaces.items[0].head_digest, finalHead);
  assert.equal(restartedStatus.secrets.configured_count, 1);
  assert.equal(restartedStatus.backups.backup_count, 1);
  assert.equal(restartedStatus.shares.share_count, 2);
  const persistentShare = await fetch(new URL(`share/${secondShareToken}`, restarted.url));
  assert.equal(persistentShare.status, 200);
  assert.equal((await persistentShare.json()).workspace.head_digest, finalHead);
});

test('hosted configuration fails closed on missing or insecure public identity', () => {
  const common = {
    ARCHIED_FOUNDER_TOKEN_SHA256: tokenSha256(founderToken),
    ARCHIED_DEVELOPER_TOKEN_SHA256: tokenSha256(developerToken),
    ARCHIED_SESSION_KEY: crypto.randomBytes(32).toString('base64'),
    ARCHIED_SECRET_KEY: crypto.randomBytes(32).toString('base64')
  };
  assert.throws(() => resolveHostedConfig({ env: common }), /absolute URL/);
  assert.throws(() => resolveHostedConfig({ env: { ...common, ARCHIED_PUBLIC_URL: 'http:\/\/archie.test/' } }), /requires an HTTPS/);
  const config = resolveHostedConfig({
    env: { ...common, ARCHIED_PUBLIC_URL: 'http://archie.test/', ARCHIED_ALLOW_INSECURE_HOSTED: '1' },
    port: 0
  });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 0);
  assert.equal(config.public_url, 'http://archie.test/');
  assert.equal(config.secure_cookies, false);
});

test('container contract is one non-root hardened provider-neutral service', async () => {
  const dockerfile = await fs.readFile(new URL('../../Dockerfile.archie', import.meta.url), 'utf8');
  const compose = await fs.readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const example = await fs.readFile(new URL('../../.env.archied.example', import.meta.url), 'utf8');
  const ignore = await fs.readFile(new URL('../../.dockerignore', import.meta.url), 'utf8');
  const documentation = await fs.readFile(new URL('../../ARCHIE_HOSTED.md', import.meta.url), 'utf8');

  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /archied-hosted\.mjs/);
  assert.doesNotMatch(dockerfile, /curl|wget|git clone/i);

  assert.match(compose, /dockerfile: Dockerfile\.archie/);
  assert.match(compose, /archie-data:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /127\.0\.0\.1/);

  assert.match(example, /ARCHIED_FOUNDER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_DEVELOPER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_SESSION_KEY/);
  assert.match(example, /ARCHIED_SECRET_KEY/);
  assert.match(ignore, /\.git/);
  assert.match(ignore, /node_modules/);
  assert.match(documentation, /without buying/i);
  assert.match(documentation, /Hard boundary/);
});
