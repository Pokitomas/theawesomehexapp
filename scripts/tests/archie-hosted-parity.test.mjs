import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveArchiedConfig, startArchied } from '../archied.mjs';
import { verifyHostedBackup } from '../archie-hosted-backup.mjs';
import { tokenSha256 } from '../archie-hosted-security.mjs';

const founderToken = 'founder-token-0123456789-archie-hosted';
const developerToken = 'developer-token-0123456789-archie-hosted';
const objective = 'Make this hosted workflow genuinely good on a phone while preserving explicit human control.';
const requestedChange = 'Preserve the final audit trail and why the alternative product hypothesis was rejected.';

function basic(role, token) {
  return `Basic ${Buffer.from(`${role}:${token}`).toString('base64')}`;
}

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function hostedOptions(home, keys) {
  return {
    home,
    host: '127.0.0.1',
    port: 0,
    mode: 'hosted',
    publicBaseUrl: 'http://archie.test/',
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    shareKey: keys.share,
    secretKey: keys.secret
  };
}

test('hosted Archie provides private role auth, stable URLs, read shares, encrypted secrets, backups, and restart parity', async t => {
  const home = await tempRoot(t, 'archie-hosted-parity-');
  const keys = {
    share: crypto.randomBytes(32).toString('base64'),
    secret: crypto.randomBytes(32).toString('base64')
  };
  const first = await startArchied(hostedOptions(home, keys));
  t.after(() => first.close().catch(() => {}));

  const health = await fetch(new URL('health', first.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    schema: 'archied-health/v1',
    status: 'ok',
    service_version: '0.2.0',
    migration_level: 2,
    mode: 'hosted'
  });

  const anonymousRoot = await fetch(first.url);
  assert.equal(anonymousRoot.status, 401);
  assert.match(anonymousRoot.headers.get('www-authenticate'), /^Basic realm="Archie"/);
  assert.equal((await anonymousRoot.json()).error, 'authentication_required');

  const anonymousWorkspaceDescriptor = await fetch(new URL('.well-known/archie-workspace-service.json', first.url));
  assert.equal(anonymousWorkspaceDescriptor.status, 401);

  const founderHeaders = { authorization: basic('founder', founderToken) };
  const developerHeaders = { authorization: basic('developer', developerToken) };
  const founderRoot = await fetch(first.url, { headers: founderHeaders });
  assert.equal(founderRoot.status, 200);
  assert.match(await founderRoot.text(), /State what should be true/);
  const developerRoot = await fetch(first.url, { headers: developerHeaders });
  assert.equal(developerRoot.status, 200);

  const descriptorResponse = await fetch(new URL('.well-known/archied.json', first.url), { headers: founderHeaders });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.mode, 'hosted');
  assert.equal(descriptor.base_url, 'http://archie.test/');
  assert.equal(descriptor.storage.root, 'managed-persistent-volume');
  assert.equal(descriptor.workspace_url_template, 'http://archie.test/w/{workspace_id}');
  assert.equal(descriptor.explicit_read_shares, true);
  assert.equal(JSON.stringify(descriptor).includes(home), false);
  assert.equal(JSON.stringify(descriptor).includes(founderToken), false);
  assert.equal(JSON.stringify(descriptor).includes(keys.secret), false);

  const developerJourney = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { ...developerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(developerJourney.status, 403);

  const journeyResponse = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { ...founderHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(journeyResponse.status, 201);
  const journey = await journeyResponse.json();
  assert.match(journey.workspace_id, /^workspace_[a-f0-9]{16}$/);
  assert.equal(journey.workspace_url, `http://archie.test/w/${journey.workspace_id}`);
  assert.equal('bundle_path' in journey, false);

  const developerWorkspace = await fetch(new URL(`w/${journey.workspace_id}`, first.url), { headers: developerHeaders });
  assert.equal(developerWorkspace.status, 403);
  const founderWorkspace = await fetch(new URL(`w/${journey.workspace_id}`, first.url), { headers: founderHeaders });
  assert.equal(founderWorkspace.status, 200);
  assert.equal((await founderWorkspace.json()).head_digest, journey.head_digest);

  const shareResponse = await fetch(new URL('v1/hosted/shares', first.url), {
    method: 'POST',
    headers: { ...founderHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: journey.workspace_id, expires_in_ms: 3_600_000 })
  });
  assert.equal(shareResponse.status, 201);
  const share = await shareResponse.json();
  assert.equal(share.share_url, `http://archie.test/v1/hosted/shares/${share.token}`);
  assert.deepEqual(share.capabilities, ['read']);

  const anonymousShare = await fetch(new URL(`v1/hosted/shares/${share.token}`, first.url));
  assert.equal(anonymousShare.status, 200);
  const shared = await anonymousShare.json();
  assert.equal(shared.workspace.workspace_id, journey.workspace_id);
  assert.equal(shared.workspace.head_digest, journey.head_digest);
  assert.deepEqual(shared.share.capabilities, ['read']);

  const shareMutation = await fetch(new URL(`v1/hosted/shares/${share.token}`, first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'rollback.record' })
  });
  assert.equal(shareMutation.status, 404);

  const deniedSecret = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT',
    headers: { ...developerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'must-not-be-written' })
  });
  assert.equal(deniedSecret.status, 403);

  const plaintext = 'private-provider-secret-value';
  const secretResponse = await fetch(new URL('v1/hosted/secrets/provider_api', first.url), {
    method: 'PUT',
    headers: { ...founderHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ value: plaintext })
  });
  assert.equal(secretResponse.status, 200);
  const secretReceipt = await secretResponse.json();
  assert.equal(secretReceipt.secret.name, 'provider_api');
  assert.equal('value' in secretReceipt.secret, false);
  const encryptedFile = path.join(first.data_root, 'hosted', 'secrets.enc.json');
  const encryptedText = await fs.readFile(encryptedFile, 'utf8');
  assert.equal(encryptedText.includes(plaintext), false);
  assert.match(encryptedText, /aes-256-gcm/);

  const beforeBackup = await fetch(new URL('v1/hosted/status', first.url), { headers: developerHeaders });
  assert.equal(beforeBackup.status, 200);
  const beforeStatus = await beforeBackup.json();
  assert.equal(beforeStatus.authenticated_role, 'developer');
  assert.equal(beforeStatus.workspace_count, 1);
  assert.equal(beforeStatus.secrets.configured_count, 1);
  assert.deepEqual(beforeStatus.secrets.secrets.map(item => item.name), ['provider_api']);
  assert.equal(JSON.stringify(beforeStatus).includes(plaintext), false);
  assert.equal(beforeStatus.backups.backup_count, 0);

  const deniedBackup = await fetch(new URL('v1/hosted/backups', first.url), {
    method: 'POST',
    headers: developerHeaders
  });
  assert.equal(deniedBackup.status, 403);

  const backupResponse = await fetch(new URL('v1/hosted/backups', first.url), {
    method: 'POST',
    headers: founderHeaders
  });
  assert.equal(backupResponse.status, 201);
  const backupReceipt = await backupResponse.json();
  assert.match(backupReceipt.backup_digest, /^[a-f0-9]{64}$/);
  assert.equal(backupReceipt.workspace_count, 1);
  assert.equal(backupReceipt.artifact_count, 2);
  const backupNames = await fs.readdir(path.join(first.data_root, 'backups'));
  assert.equal(backupNames.length, 1);
  const backupText = await fs.readFile(path.join(first.data_root, 'backups', backupNames[0]), 'utf8');
  assert.equal(backupText.includes(plaintext), false);
  const backup = verifyHostedBackup(JSON.parse(backupText));
  assert.equal(backup.backup_digest, backupReceipt.backup_digest);
  assert.equal(backup.encrypted_secrets.schema, 'archie-encrypted-secret-store/v1');
  assert.equal('key' in backup.encrypted_secrets, false);

  const afterBackup = await fetch(new URL('v1/hosted/status', first.url), { headers: founderHeaders });
  const afterStatus = await afterBackup.json();
  assert.equal(afterStatus.backups.backup_count, 1);
  assert.equal(afterStatus.backups.latest.backup_digest, backupReceipt.backup_digest);

  await first.close();
  const restarted = await startArchied(hostedOptions(home, keys));
  t.after(() => restarted.close().catch(() => {}));
  const restartedStatusResponse = await fetch(new URL('v1/hosted/status', restarted.url), { headers: founderHeaders });
  assert.equal(restartedStatusResponse.status, 200);
  const restartedStatus = await restartedStatusResponse.json();
  assert.equal(restartedStatus.workspace_count, 1);
  assert.equal(restartedStatus.secrets.configured_count, 1);
  assert.equal(restartedStatus.backups.backup_count, 1);
  const restartedWorkspace = await fetch(new URL(`w/${journey.workspace_id}`, restarted.url), { headers: founderHeaders });
  assert.equal(restartedWorkspace.status, 200);
  assert.equal((await restartedWorkspace.json()).head_digest, journey.head_digest);
});

test('hosted configuration fails closed on missing or insecure public identity', () => {
  const common = {
    ARCHIED_MODE: 'hosted',
    ARCHIED_FOUNDER_TOKEN_SHA256: tokenSha256(founderToken),
    ARCHIED_DEVELOPER_TOKEN_SHA256: tokenSha256(developerToken),
    ARCHIED_SHARE_KEY: crypto.randomBytes(32).toString('base64'),
    ARCHIED_SECRET_KEY: crypto.randomBytes(32).toString('base64')
  };
  assert.throws(() => resolveArchiedConfig({ argv: [], env: common }), /absolute URL/);
  assert.throws(() => resolveArchiedConfig({ argv: [], env: { ...common, ARCHIED_PUBLIC_URL: 'http:\/\/archie.test/' } }), /requires an HTTPS/);
  const config = resolveArchiedConfig({
    argv: ['--port', '0'],
    env: { ...common, ARCHIED_PUBLIC_URL: 'http://archie.test/', ARCHIED_ALLOW_INSECURE_HOSTED: '1' }
  });
  assert.equal(config.mode, 'hosted');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 0);
  assert.equal(config.publicBaseUrl, 'http://archie.test/');
});

test('hosted container contract is one non-root hardened provider-neutral service', async () => {
  const dockerfile = await fs.readFile(new URL('../../Dockerfile.archied', import.meta.url), 'utf8');
  const compose = await fs.readFile(new URL('../../compose.archied.yml', import.meta.url), 'utf8');
  const example = await fs.readFile(new URL('../../.env.archied.example', import.meta.url), 'utf8');
  const documentation = await fs.readFile(new URL('../../ARCHIE_HOSTED.md', import.meta.url), 'utf8');

  assert.match(dockerfile, /FROM node:20-bookworm-slim/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /archied\.mjs/);
  assert.doesNotMatch(dockerfile, /curl|wget|git clone/i);

  assert.match(compose, /dockerfile: Dockerfile\.archied/);
  assert.match(compose, /archie-data:\/var\/lib\/archie/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /127\.0\.0\.1/);

  assert.match(example, /ARCHIED_FOUNDER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_DEVELOPER_TOKEN_SHA256/);
  assert.match(example, /ARCHIED_SHARE_KEY/);
  assert.match(example, /ARCHIED_SECRET_KEY/);
  assert.match(documentation, /No paid|without buying/i);
  assert.match(documentation, /Hard boundary/);
});
