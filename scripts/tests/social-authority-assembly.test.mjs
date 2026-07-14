import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('social assembly retains every source authority boundary', async () => {
  const [runtime, relational, entrypoint, blob, migrations, packageText] = await Promise.all([
    read('netlify/functions/social-postgres-community-runtime.mjs'),
    read('netlify/functions/social-relational-core.mjs'),
    read('netlify/functions/social-entrypoint-core.mjs'),
    read('netlify/functions/social-core.mjs'),
    read('netlify/functions/social-postgres-migrations.mjs'),
    read('package.json')
  ]);

  for (const token of [
    'currentSocialMutationIdentity',
    'assertSocialReceiptReplay',
    'assertModerationTargetAction',
    'assertMemberModerationHierarchy',
    'appealed_action_id',
    'appeal_target',
    'assertLocalControlPair',
    'viewerEligibility',
    'viewerThreadProjection'
  ]) assert.ok(runtime.includes(token), `shared runtime lost ${token}`);

  assert.ok(relational.includes('withSocialMutationContext'), 'relational service lost request identity context');
  assert.ok(entrypoint.includes('cookieMutationProvenanceResponse'), 'entrypoint lost cookie provenance denial');
  assert.ok(blob.includes("request.method === 'DELETE' && op === 'post'"), 'Blob authority lost author deletion endpoint');
  assert.ok(blob.includes("'post.author_deleted'"), 'Blob authority lost durable deletion event');

  for (const name of [
    '001_social_authority.sql',
    '002_community_conversation_authority.sql',
    '003_social_idempotency_identity.sql',
    '004_immutable_appeal_actions.sql',
    '005_quarantine_legacy_idempotency_receipts.sql'
  ]) assert.ok(migrations.includes(name), `migration loader lost ${name}`);

  const pkg = JSON.parse(packageText);
  for (const witness of [
    'social-cookie-provenance.test.mjs',
    'social-idempotency.test.mjs',
    'social-idempotency-postgres.test.mjs',
    'social-authority-schema-bootstrap.test.mjs',
    'immutable-appeal-postgres.test.mjs',
    'community-moderation-postgres.test.mjs',
    'social-viewer-controls.test.mjs',
    'community-viewer-controls-postgres.test.mjs'
  ]) {
    const scripts = Object.values(pkg.scripts || {}).join(' ');
    assert.ok(scripts.includes(witness), `test scripts lost ${witness}`);
  }
});
