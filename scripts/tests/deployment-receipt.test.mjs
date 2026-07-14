import assert from 'node:assert/strict';
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
