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
  PUBLIC_SURFACE_SET_SCHEMA,
  PUBLIC_SURFACES,
  archieUrl,
  buildDeploymentReceiptBody,
  buildDeploymentSentinel,
  desktopUrl,
  desktopAliasUrl,
  founderUrl,
  sentinelUrl,
  surfaceUrl,
  verifyAllPublicSurfaces,
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

const sentinel = (commit = 'new') => ({ schema: 3, product_root: 'desktop-program-manager', product_model: 'independent-programs', commit, repository: 'Pokitomas/theawesomehexapp' });

function successfulReceipt(surface, commit = 'new') {
  return { schema: 'test/v1', surface, url: surfaceUrl('https://example.test/app/', surface), anonymous: true, status: 200, login_redirect: false, expected_commit: commit, observed_commit: commit };
}

test('deployment identity names Program Manager as the exact product root', () => {
  assert.deepEqual(buildDeploymentSentinel({ commit: 'abc123', repository: 'Pokitomas/theawesomehexapp' }), {
    schema: 3, product_root: 'desktop-program-manager', product_model: 'independent-programs', commit: 'abc123', repository: 'Pokitomas/theawesomehexapp'
  });
  assert.equal(desktopUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/');
  assert.equal(desktopAliasUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/desktop/');
  assert.equal(founderUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/founder/');
  assert.equal(archieUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/archie/');
  assert.equal(sentinelUrl('https://pokitomas.github.io/theawesomehexapp'), 'https://pokitomas.github.io/theawesomehexapp/.well-known/archie-deployment.json');
  const receipts = PUBLIC_SURFACES.map(item => successfulReceipt(item.id, 'abc123'));
  const body = buildDeploymentReceiptBody({ deployedUrl: 'https://pokitomas.github.io/theawesomehexapp', commit: 'abc123', surfaceReceipts: receipts });
  assert.match(body, /ROOT_PRODUCT=Archie Program Manager/);
  assert.match(body, /PRODUCT_MODEL=independent opaque applications/);
  assert.match(body, /DESKTOP_URL=.*\/desktop\//);
  assert.match(body, /ALL_PUBLIC_SURFACES_VERIFIED=true/);
  for (const definition of PUBLIC_SURFACES) assert.match(body, new RegExp(`${definition.label}_ANONYMOUS_REACHABLE=true`));
  assert.doesNotMatch(body, /MANUAL_URL|PHONE_TEST_URL|one-million-candidate feed/);
});

test('receipt fails closed when even one public program is missing', () => {
  const receipts = PUBLIC_SURFACES.filter(item => item.id !== 'maker').map(item => successfulReceipt(item.id));
  const body = buildDeploymentReceiptBody({ deployedUrl: 'https://example.test/app/', commit: 'new', surfaceReceipts: receipts });
  assert.match(body, /ALL_PUBLIC_SURFACES_VERIFIED=false/);
  assert.match(body, /MAKER_ANONYMOUS_REACHABLE=false/);
});

test('live verification rejects stale or non-Program-Manager deployments', async () => {
  const responses = [sentinel('old'), sentinel('new')];
  const result = await verifyLiveDeployment({ deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 2, delayMs: 0, async fetchImpl() { return { ok: true, async json() { return responses.shift(); } }; } });
  assert.equal(result.attempt, 2);
  await assert.rejects(() => verifyLiveDeployment({ deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0, async fetchImpl() { return { ok: true, async json() { return { ...sentinel('new'), product_root: 'sideways' }; } }; } }), /served product root sideways/);
});

function publicFetch() {
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'follow');
    if (url.includes('.well-known')) return { ok: true, status: 200, async json() { return sentinel('new'); } };
    const pathname = new URL(url).pathname;
    const definition = PUBLIC_SURFACES.find(item => item.route ? pathname.endsWith(`/${item.route}`) : pathname.endsWith('/app/'));
    const markers = {
      root: 'Archie Program Manager', desktop: 'Archie Program Manager', founder: 'FOUNDER / HUMAN INVENTION POWER', foundry: 'Foundry Research Control', archie: 'Archie Knowledge Utility', maker: 'MAKER.EXE / PROJECT WORKBENCH', expo: 'Frontier World Expo', example: 'Tiny Public Things'
    };
    assert.ok(definition, `unrecognized route ${url}`);
    return { ok: true, status: 200, url, async text() { return markers[definition.id]; } };
  };
}

test('every final program is anonymously reachable, independently marked, and commit-bound', async () => {
  const result = await verifyAllPublicSurfaces({ deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0, fetchImpl: publicFetch() });
  assert.equal(result.schema, PUBLIC_SURFACE_SET_SCHEMA);
  assert.equal(result.receipts.length, PUBLIC_SURFACES.length);
  assert.deepEqual(result.receipts.map(item => item.surface), PUBLIC_SURFACES.map(item => item.id));
  for (const item of result.receipts) {
    assert.equal(item.status, 200);
    assert.equal(item.anonymous, true);
    assert.equal(item.observed_commit, 'new');
  }
  const founder = await verifyFounderPublicReachability({ deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0, fetchImpl: publicFetch() });
  const archie = await verifyArchiePublicReachability({ deployedUrl: 'https://example.test/app/', expectedCommit: 'new', expectedRepository: 'Pokitomas/theawesomehexapp', attempts: 1, delayMs: 0, fetchImpl: publicFetch() });
  assert.equal(founder.schema, FOUNDER_RECEIPT_SCHEMA);
  assert.equal(archie.schema, ARCHIE_RECEIPT_SCHEMA);
});

test('receipt upsert migrates legacy deployment issues to the complete independent-program receipt', async () => {
  const updates = [];
  const github = { async paginate() { return [{ number: 396, title: LEGACY_RECEIPT_TITLES[0] }]; }, rest: { issues: {
    async listForRepo() { throw new Error('paginate should own listing'); },
    async create() { throw new Error('legacy receipt should be migrated'); },
    async update(input) { updates.push(input); return { data: { number: input.issue_number, ...input } }; }
  } } };
  const surfaceReceipts = PUBLIC_SURFACES.map(item => successfulReceipt(item.id, 'new123'));
  const result = await upsertDeploymentReceipt({ github, context: { repo: { owner: 'Pokitomas', repo: 'theawesomehexapp' }, sha: 'new123' }, deployedUrl: 'https://example.test/app/', surfaceReceipts });
  assert.equal(result.primary.number, 396);
  assert.equal(updates[0].title, RECEIPT_TITLE);
  assert.match(updates[0].body, /ALL_PUBLIC_SURFACES_VERIFIED=true/);
});

test('Pages workflow verifies every live route before writing the final receipt', () => {
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
  const verifyAll = deployJob.indexOf('node scripts/deployment-receipt.cjs verify-all-live');
  const upsert = deployJob.indexOf('upsertDeploymentReceipt');
  assert.ok(verifyLive > deployPages);
  assert.ok(verifyAll > verifyLive);
  assert.ok(upsert > verifyAll);
  assert.match(deployJob, /public-surface-reachability-receipts\.json/);
});
