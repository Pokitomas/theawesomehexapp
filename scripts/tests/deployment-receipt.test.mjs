import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import receipt from '../deployment-receipt.cjs';

const {
  RECEIPT_TITLE,
  buildDeploymentReceiptBody,
  buildDeploymentSentinel,
  sentinelUrl,
  verifyLiveDeployment,
  upsertDeploymentReceipt
} = receipt;

const immutableAction = name => new RegExp(`uses:\\s*${name.replace('/', '\\/')}@[0-9a-f]{40}(?:\\s+#\\s*v\\d+)?`);

function loadPagesWorkflow({
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
  readFile = readFileSync
} = {}) {
  const workflowPath = resolve(workspace, '.github/workflows/pages.yml');
  const workflow = readFile(workflowPath, 'utf8');
  if (!workflow.includes('name: Build and deploy manual root-kernel feed')) {
    throw new Error(`Unexpected Pages workflow content at ${workflowPath}`);
  }
  return { workflowPath, workflow };
}

test('deployment identity and receipt expose the exact live commit', () => {
  assert.deepEqual(buildDeploymentSentinel({
    commit: 'abc123',
    repository: 'Pokitomas/theawesomehexapp'
  }), {
    schema: 1,
    commit: 'abc123',
    repository: 'Pokitomas/theawesomehexapp'
  });

  assert.equal(
    sentinelUrl('https://pokitomas.github.io/theawesomehexapp'),
    'https://pokitomas.github.io/theawesomehexapp/.well-known/sideways-deployment.json'
  );

  const body = buildDeploymentReceiptBody({
    deployedUrl: 'https://pokitomas.github.io/theawesomehexapp',
    commit: 'abc123'
  });
  assert.match(body, /^ROOT_URL=https:\/\/pokitomas\.github\.io\/theawesomehexapp\//);
  assert.match(body, /COMMIT=abc123/);
  assert.match(body, /DEPLOYMENT_SENTINEL_URL=https:\/\/pokitomas\.github\.io\/theawesomehexapp\/\.well-known\/sideways-deployment\.json/);
  assert.match(body, /LIVE_COMMIT_VERIFIED=true/);
});

test('live verification rejects a stale deployment and retries until the expected commit appears', async () => {
  const responses = [
    { commit: 'old', repository: 'Pokitomas/theawesomehexapp' },
    { commit: 'new', repository: 'Pokitomas/theawesomehexapp' }
  ];
  const requested = [];
  const result = await verifyLiveDeployment({
    deployedUrl: 'https://example.test/app/',
    expectedCommit: 'new',
    expectedRepository: 'Pokitomas/theawesomehexapp',
    attempts: 2,
    delayMs: 0,
    async fetchImpl(url, options) {
      requested.push({ url, options });
      return {
        ok: true,
        async json() { return responses.shift(); }
      };
    }
  });

  assert.equal(result.attempt, 2);
  assert.equal(result.sentinel.commit, 'new');
  assert.equal(requested.length, 2);
  assert.match(requested[0].url, /attempt=1/);
  assert.deepEqual(requested[0].options.headers, { 'cache-control': 'no-cache' });
});

test('receipt upsert creates the first deployment issue', async () => {
  const calls = [];
  const github = {
    rest: {
      issues: {
        async listForRepo() { return { data: [] }; },
        async create(input) {
          calls.push(['create', input]);
          return { data: { number: 104, ...input } };
        },
        async update(input) {
          calls.push(['update', input]);
          return { data: input };
        }
      }
    }
  };

  const result = await upsertDeploymentReceipt({
    github,
    context: { repo: { owner: 'Pokitomas', repo: 'theawesomehexapp' }, sha: 'abc123' },
    deployedUrl: 'https://example.test/app/'
  });

  assert.equal(result.primary.number, 104);
  assert.deepEqual(result.closedDuplicates, []);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].title, RECEIPT_TITLE);
  assert.match(calls[0][1].body, /COMMIT=abc123/);
});

test('receipt upsert updates the newest open receipt and closes stale duplicates', async () => {
  const updates = [];
  const issues = [
    { number: 95, title: RECEIPT_TITLE },
    { number: 104, title: RECEIPT_TITLE },
    { number: 103, title: RECEIPT_TITLE, pull_request: { url: 'pr' } },
    { number: 20, title: 'other' }
  ];
  const github = {
    async paginate(_method, params) {
      assert.equal(params.state, 'open');
      return issues;
    },
    rest: {
      issues: {
        async listForRepo() { throw new Error('paginate should own listing'); },
        async create() { throw new Error('existing receipt should be updated'); },
        async update(input) {
          updates.push(input);
          return { data: { number: input.issue_number, ...input } };
        }
      }
    }
  };

  const result = await upsertDeploymentReceipt({
    github,
    context: { repo: { owner: 'Pokitomas', repo: 'theawesomehexapp' }, sha: 'new123' },
    deployedUrl: 'https://example.test/app/'
  });

  assert.equal(result.primary.number, 104);
  assert.deepEqual(result.closedDuplicates, [95]);
  assert.equal(updates[0].issue_number, 104);
  assert.match(updates[0].body, /COMMIT=new123/);
  assert.deepEqual(updates[1], {
    owner: 'Pokitomas',
    repo: 'theawesomehexapp',
    issue_number: 95,
    state: 'closed',
    state_reason: 'not_planned'
  });
});

test('workflow loader anchors to the checked-out workspace instead of the test module URL', () => {
  const reads = [];
  const result = loadPagesWorkflow({
    workspace: '/checkout/repository',
    readFile(path, encoding) {
      reads.push({ path, encoding });
      return 'name: Build and deploy manual root-kernel feed\n';
    }
  });

  assert.equal(result.workflowPath, resolve('/checkout/repository', '.github/workflows/pages.yml'));
  assert.deepEqual(reads, [{
    path: resolve('/checkout/repository', '.github/workflows/pages.yml'),
    encoding: 'utf8'
  }]);
});

test('Pages workflow cannot record a receipt before the live commit is verified', () => {
  const { workflow } = loadPagesWorkflow();
  const writeSentinel = workflow.indexOf('node scripts/deployment-receipt.cjs write-sentinel');
  const uploadArtifactMatch = workflow.match(immutableAction('actions/upload-pages-artifact'));
  const deployJobStart = workflow.indexOf('\n  deploy:\n');

  assert.ok(writeSentinel >= 0, 'workflow must write a deployment sentinel');
  assert.ok(uploadArtifactMatch?.index > writeSentinel, 'sentinel must be inside the uploaded Pages artifact');
  assert.ok(deployJobStart > uploadArtifactMatch.index, 'deploy job must follow artifact upload');

  const deployJob = workflow.slice(deployJobStart);
  const checkout = deployJob.search(immutableAction('actions/checkout'));
  const deployPages = deployJob.search(immutableAction('actions/deploy-pages'));
  const verifyLive = deployJob.indexOf('node scripts/deployment-receipt.cjs verify-live');
  const upsertReceipt = deployJob.indexOf('const { upsertDeploymentReceipt } = require');

  assert.ok(checkout >= 0, 'deploy job must check out the tested helper');
  assert.ok(deployPages > checkout, 'Pages deployment must follow deploy-job checkout');
  assert.ok(verifyLive > deployPages, 'live verification must run after Pages deployment');
  assert.ok(upsertReceipt > verifyLive, 'receipt must be written only after live verification');
});
