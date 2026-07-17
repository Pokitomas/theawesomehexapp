import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import receipt from '../deployment-receipt.cjs';

const {
  RECEIPT_TITLE,
  LEGACY_RECEIPT_TITLES,
  FOUNDER_RECEIPT_SCHEMA,
  ARCHIE_RECEIPT_SCHEMA,
  archieUrl,
  buildDeploymentReceiptBody,
  buildDeploymentSentinel,
  desktopUrl,
  founderUrl,
  sentinelUrl,
  verifyArchiePublicReachability,
  verifyFounderPublicReachability,
  verifyLiveDeployment,
  upsertDeploymentReceipt
} = receipt;

const immutableAction = name => new RegExp(`uses:\\s*${name.replace('/', '\\/')}@[0-9a-f]{40}(?:\\s+#\\s*v\\d+)?`);

function loadPagesWorkflow({ workspace = process.env.GITHUB_WORKSPACE || process.cwd(), readFile = readFileSync } = {}) {
  const workflowPath = resolve(workspace, '.github/workflows/pages.yml');
  const workflow = readFile(workflowPath, 'utf8');
  if (!workflow.includes('name: Build and deploy independent program surfaces')) throw new Error(`Unexpected Pages workflow content at ${workflowPath}`);
  return { workflowPath, workflow };
}

const sentinel = (commit = 'new') => ({
  schema: 3,
  product_root: 'desktop-program-manager',
  product_model: 'independent-programs',
  commit,
  repository: 'Pokitomas/theawesomehexapp'
});

test('deployment identity names Program Manager as the exact product root', () => {
  assert.deepEqual(buildDeploymentSentinel({ commit: 'abc123', repository: 'Pokitomas/theawesomehexapp' }), {
    schema: 3,
    product_root: 'desktop-program-manager',
    product_model: 'independent-programs',
    commit: 'abc123',
    repository: 'Pokitomas/theawesomehexapp'
  });
  assert.equal(desktopUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/');
  assert.equal(founderUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/founder/');
  assert.equal(archieUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/archie/');
  assert.equal(sentinelUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/.well-known/archie-deployment.json');
  const body = buildDeploymentReceiptBody({ deployedUrl: 'https://pokitomas.github.io/theawesomehexapp', commit: 'abc123' });
  assert.match(body, /ROOT_PRODUCT=Archie Program Manager/);
  assert.match(body, /PRODUCT_MODEL=independent opaque applications/);
  assert.match(body, /FOUNDER_URL=.*\/founder\//);
  assert.match(body, /FOUNDRY_URL=.*\/foundry\//);
  assert.match(body, /SUPERIORITY_CLAIM=blocked until blinded matched real-user evidence/);
  assert.doesNotMatch(body, /MANUAL_URL|PHONE_TEST_URL|one-million-candidate feed/);
});

test('live verification rejects stale or non-Program-Manager deployments', async () => {
  const responses = [sentinel('old'), sentinel('new')];
  const result = await verifyLiveDeployment({
    deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 2, delayMs: 0,
    async fetchImpl() { return { ok: true, async json() { return responses.shift(); } }; }
  });
  assert.equal(result.attempt, 2);
  await assert.rejects(() => verifyLiveDeployment({
    deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0,
    async fetchImpl() { return { ok: true, async json() { return { ...sentinel('new'), product_root: 'sideways' }; } }; }
  }), /served product root sideways/);
});

function publicFetch(marker, route) {
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'follow');
    if (url.includes('.well-known')) return { ok: true, status: 200, async json() { return sentinel('new'); } };
    return { ok: true, status: 200, url: `https://example.test/app/${route}`, async text() { return marker; } };
  };
}

test('Founder and Archie public verification are anonymous, independently routed, and commit-bound', async () => {
  const founder = await verifyFounderPublicReachability({
    deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0,
    fetchImpl: publicFetch('<p>FOUNDER / HUMAN INVENTION POWER</p>', 'founder/')
  });
  const archie = await verifyArchiePublicReachability({
    deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0,
    fetchImpl: publicFetch('<p>Archie Knowledge Utility</p>', 'archie/')
  });
  assert.equal(founder.schema, FOUNDER_RECEIPT_SCHEMA);
  assert.equal(archie.schema, ARCHIE_RECEIPT_SCHEMA);
  assert.equal(founder.url, 'https://example.test/app/founder/');
  assert.equal(archie.url, 'https://example.test/app/archie/');
  assert.equal(founder.observed_commit, 'new');
  assert.equal(archie.observed_commit, 'new');
});

test('receipt upsert migrates legacy deployment issues to the independent-program receipt', async () => {
  const updates = [];
  const github = {
    async paginate() { return [{ number: 396, title: LEGACY_RECEIPT_TITLES[0] }]; },
    rest: { issues: {
      async listForRepo() { throw new Error('paginate should own listing'); },
      async create() { throw new Error('legacy receipt should be migrated'); },
      async update(input) { updates.push(input); return { data: { number: input.issue_number, ...input } }; }
    } }
  };
  const result = await upsertDeploymentReceipt({
    github,
    context: { repo: { owner: 'Pokitomas', repo: 'theawesomehexapp' }, sha: 'new123' },
    deployedUrl: 'https://example.test/app/'
  });
  assert.equal(result.primary.number, 396);
  assert.equal(updates[0].title, RECEIPT_TITLE);
  assert.match(updates[0].body, /ROOT_PRODUCT=Archie Program Manager/);
});

test('Pages workflow builds independent public programs and verifies live routes before writing the receipt', () => {
  const { workflow } = loadPagesWorkflow();
  assert.doesNotMatch(workflow, /manual-overlay|manual-kernel|Add to Sideways|SIDEWAYS_PUBLIC_SOURCES|build\.mjs/);
  const publishHuman = workflow.indexOf('node scripts/publish-human-surfaces.mjs dist');
  const writeSentinel = workflow.indexOf('node scripts/deployment-receipt.cjs write-sentinel');
  const verifyRoot = workflow.indexOf("grep -q 'Archie Program Manager' dist/index.html");
  const upload = workflow.match(immutableAction('actions/upload-pages-artifact'));
  const deployJobStart = workflow.indexOf('\n  deploy:\n');
  assert.ok(publishHuman >= 0);
  assert.ok(writeSentinel > publishHuman);
  assert.ok(verifyRoot > writeSentinel);
  assert.ok(upload?.index > verifyRoot);
  assert.ok(deployJobStart > upload.index);
  const deployJob = workflow.slice(deployJobStart);
  const deployPages = deployJob.search(immutableAction('actions/deploy-pages'));
  const verifyLive = deployJob.indexOf('node scripts/deployment-receipt.cjs verify-live');
  const verifyFounder = deployJob.indexOf('node scripts/deployment-receipt.cjs verify-founder-live');
  const verifyArchie = deployJob.indexOf('node scripts/deployment-receipt.cjs verify-archie-live');
  const upsert = deployJob.indexOf('upsertDeploymentReceipt');
  assert.ok(verifyLive > deployPages);
  assert.ok(verifyFounder > verifyLive);
  assert.ok(verifyArchie > verifyFounder);
  assert.ok(upsert > verifyArchie);
});
