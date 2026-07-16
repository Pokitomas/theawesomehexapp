import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MakerGitHubBroker,
  digest,
  normalizeAuthorityPacket,
  normalizeCredential,
  normalizeRepository,
  redactSecrets
} from '../maker-github-broker.mjs';

const SHA = 'a'.repeat(40);

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: key => normalized[String(key).toLowerCase()] ?? null };
}

function response(status, data, values = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status >= 200 && status < 300 ? 'OK' : 'ERROR',
    headers: headers(values),
    text: async () => data === null || data === undefined ? '' : JSON.stringify(data)
  };
}

function routeFetch(routes, calls = []) {
  return {
    calls,
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const method = String(options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url: parsed.toString(), path: `${parsed.pathname}${parsed.search}`, method, headers: options.headers, body });
      for (const route of routes) {
        if ((route.method || 'GET') !== method) continue;
        const match = typeof route.path === 'string' ? `${parsed.pathname}${parsed.search}` === route.path : route.path.test(`${parsed.pathname}${parsed.search}`);
        if (!match) continue;
        if (typeof route.handle === 'function') return route.handle({ url: parsed, method, body, options, calls });
        return response(route.status ?? 200, route.data, route.headers);
      }
      throw new Error(`unhandled ${method} ${parsed.pathname}${parsed.search}`);
    }
  };
}

function fixedClock() {
  let tick = 0;
  return () => `2026-07-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function repoMetadata(overrides = {}) {
  return {
    full_name: 'acme/widgets',
    default_branch: 'main',
    private: false,
    archived: false,
    disabled: false,
    fork: false,
    owner: { type: 'Organization' },
    permissions: { pull: true, triage: true, push: true, maintain: false, admin: false },
    ...overrides
  };
}

test('repository and credential normalization never expose the raw token', () => {
  assert.equal(normalizeRepository('https://github.com/acme/widgets.git').repository, 'acme/widgets');
  assert.throws(() => normalizeRepository('widgets'), /owner\/repository/);
  const credential = normalizeCredential({
    kind: 'fine-grained-pat',
    token: 'github_pat_123456789012345678901234567890',
    actor: 'kai',
    configured_capabilities: ['repository:create', 'issues:write', 'repository:create']
  });
  assert.equal(credential.descriptor.kind, 'fine-grained-pat');
  assert.equal(credential.descriptor.token_present, true);
  assert.deepEqual(credential.descriptor.configured_capabilities, ['issues:write', 'repository:create']);
  assert.ok(!JSON.stringify(credential.descriptor).includes('github_pat_'));
  assert.match(redactSecrets('Bearer github_pat_123456789012345678901234567890'), /\[REDACTED\]/);
});

test('repository inspection observes repository permission without guessing token scopes', async () => {
  const transport = routeFetch([
    {
      path: '/repos/acme/widgets',
      data: repoMetadata(),
      headers: {
        'x-github-request-id': 'REQ-1',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999'
      }
    }
  ]);
  const broker = new MakerGitHubBroker({
    credential: { kind: 'github-actions', token: 'ghp_123456789012345678901234567890' },
    fetch_impl: transport.fetch,
    clock: fixedClock(),
    retries: 0
  });
  const repository = await broker.inspectRepository('acme/widgets');
  assert.equal(repository.permission, 'write');
  assert.equal(repository.default_branch, 'main');
  assert.equal(repository.receipt.request_id, 'REQ-1');
  const capabilities = await broker.discoverCapabilities('acme/widgets');
  assert.equal(capabilities.capabilities['repository:read'].available, true);
  assert.equal(capabilities.capabilities['contents:write'].available, true);
  assert.equal(capabilities.capabilities['repository:create'].state, 'denied');
  assert.equal(capabilities.capabilities['repository:create'].available, false);
  assert.equal(capabilities.capabilities['issues:write'].state, 'unknown');
  assert.ok(!JSON.stringify(broker.snapshot()).includes('ghp_'));
});

test('configured account capabilities remain explicit rather than inferred from PAT type', async () => {
  const transport = routeFetch([{ path: '/repos/acme/widgets', data: repoMetadata({ permissions: { pull: true } }) }]);
  const broker = new MakerGitHubBroker({
    credential: {
      kind: 'fine-grained-pat',
      token: 'github_pat_123456789012345678901234567890',
      configured_capabilities: ['repository:create', 'issues:write', 'pull-requests:write']
    },
    fetch_impl: transport.fetch,
    clock: fixedClock(),
    retries: 0
  });
  const capabilities = await broker.discoverCapabilities('acme/widgets');
  assert.equal(capabilities.capabilities['contents:write'].available, false);
  assert.equal(capabilities.capabilities['repository:create'].state, 'configured');
  assert.equal(capabilities.capabilities['issues:write'].available, true);
  assert.equal(capabilities.capabilities['pull-requests:write'].available, true);
});

test('bounded retries preserve attempts, rate limits, one backoff, and idempotency', async () => {
  let count = 0;
  const transport = routeFetch([
    {
      method: 'POST',
      path: '/repos/acme/widgets/issues',
      handle: () => {
        count += 1;
        if (count === 1) return response(429, { message: 'slow down' }, { 'retry-after': '0', 'x-ratelimit-remaining': '0' });
        return response(201, { number: 7, html_url: 'https://github.com/acme/widgets/issues/7' }, { 'x-github-request-id': 'REQ-2' });
      }
    }
  ]);
  const sleeps = [];
  const broker = new MakerGitHubBroker({
    credential: { kind: 'fine-grained-pat', token: 'token' },
    fetch_impl: transport.fetch,
    sleep: async ms => sleeps.push(ms),
    clock: fixedClock(),
    retries: 2,
    retry_base_ms: 1
  });
  const first = await broker.createIssue('acme/widgets', { title: 'Fix', body: 'Do it', idempotency_key: 'issue-7' });
  const second = await broker.createIssue('acme/widgets', { title: 'Fix', body: 'Do it', idempotency_key: 'issue-7' });
  assert.equal(first.number, 7);
  assert.equal(second.number, 7);
  assert.equal(count, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(first.receipt.attempts.length, 2);
  assert.equal(first.receipt.attempts[0].status, 429);
  assert.equal(first.receipt.attempts[1].status, 201);
});

test('GitHub 403 secondary rate limits retry once and remain distinct from ordinary permission denial', async () => {
  let count = 0;
  const sleeps = [];
  const transport = routeFetch([
    {
      path: '/repos/acme/widgets',
      handle: () => {
        count += 1;
        if (count === 1) return response(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }, { 'retry-after': '0', 'x-ratelimit-remaining': '4999' });
        return response(200, repoMetadata(), { 'x-ratelimit-remaining': '4998' });
      }
    }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, sleep: async ms => sleeps.push(ms), clock: fixedClock(), retries: 1, retry_base_ms: 1 });
  const repository = await broker.inspectRepository('acme/widgets');
  assert.equal(repository.permission, 'write');
  assert.equal(count, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(repository.receipt.attempts[0].status, 403);
  assert.equal(repository.receipt.attempts[0].secondary_rate_limited, true);

  const denied = routeFetch([{ path: '/repos/acme/denied', status: 403, data: { message: 'Resource not accessible by integration' } }]);
  const deniedBroker = new MakerGitHubBroker({ fetch_impl: denied.fetch, sleep: async () => { throw new Error('ordinary 403 must not retry'); }, clock: fixedClock(), retries: 3 });
  await assert.rejects(deniedBroker.inspectRepository('acme/denied'), error => error.status === 403 && error.retryable === false);
  assert.equal(denied.calls.length, 1);
});

test('pagination follows Link headers and respects a hard item ceiling', async () => {
  const transport = routeFetch([
    {
      path: '/repos/acme/widgets/pulls/9/reviews?per_page=2',
      data: [{ id: 1 }, { id: 2 }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls/9/reviews?page=2&per_page=2>; rel="next"' }
    },
    {
      path: '/repos/acme/widgets/pulls/9/reviews?page=2&per_page=2',
      data: [{ id: 3 }, { id: 4 }]
    }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  const result = await broker.paginate('/repos/acme/widgets/pulls/9/reviews', { per_page: 2, max_items: 3 });
  assert.deepEqual(result.items.map(value => value.id), [1, 2, 3]);
  assert.equal(result.truncated, true);
  assert.equal(result.receipts.length, 2);
});

test('refs resolve to exact SHAs and branch creation is API mutation with validation', async () => {
  const transport = routeFetch([
    { path: `/repos/acme/widgets/commits/${SHA}`, data: { sha: SHA } },
    { path: '/repos/acme/widgets/commits/main', data: { sha: SHA } },
    {
      method: 'POST',
      path: '/repos/acme/widgets/git/refs',
      handle: ({ body }) => response(201, { ref: body.ref, object: { sha: body.sha } })
    }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  assert.equal((await broker.resolveRef('acme/widgets', SHA)).sha, SHA);
  assert.equal((await broker.resolveRef('acme/widgets', 'main')).sha, SHA);
  const branch = await broker.createBranch('acme/widgets', { branch: 'maker/task', sha: SHA });
  assert.equal(branch.branch, 'maker/task');
  const call = transport.calls.find(value => value.path === '/repos/acme/widgets/git/refs');
  assert.deepEqual(call.body, { ref: 'refs/heads/maker/task', sha: SHA });
  await assert.rejects(broker.createBranch('acme/widgets', { branch: 'bad branch', sha: SHA }), /invalid/);
});

test('issues, comments, and public titles redact secret-like material before transport', async () => {
  const transport = routeFetch([
    { method: 'POST', path: '/repos/acme/widgets/issues', data: { number: 3, html_url: 'https://github.com/acme/widgets/issues/3' }, status: 201 },
    { method: 'POST', path: '/repos/acme/widgets/issues/3/comments', data: { id: 4, html_url: 'https://github.com/acme/widgets/issues/3#issuecomment-4' }, status: 201 }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  const secret = 'github_pat_123456789012345678901234567890';
  await broker.createIssue('acme/widgets', { title: `Task ${secret}`, body: `failure Bearer ${secret}` });
  await broker.comment('acme/widgets', 3, `failure Bearer ${secret}`);
  const issue = transport.calls.find(value => value.path === '/repos/acme/widgets/issues');
  const comment = transport.calls.find(value => value.path.endsWith('/comments'));
  assert.match(issue.body.title, /\[REDACTED\]/);
  assert.match(issue.body.body, /\[REDACTED\]/);
  assert.match(comment.body.body, /\[REDACTED\]/);
  assert.ok(!JSON.stringify(issue.body).includes(secret));
  assert.ok(!JSON.stringify(comment.body).includes(secret));
});

test('same-repository and cross-repository draft PR payloads stay distinct', async () => {
  const transport = routeFetch([
    {
      method: 'POST',
      path: '/repos/acme/widgets/pulls',
      handle: ({ body }) => response(201, {
        number: body.head_repo ? 12 : 11,
        html_url: `https://github.com/acme/widgets/pull/${body.head_repo ? 12 : 11}`,
        draft: body.draft,
        head: { sha: SHA },
        base: { sha: 'b'.repeat(40) }
      })
    }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  const same = await broker.createDraftPull('acme/widgets', { title: 'Same', head: 'maker/task', base: 'main' });
  const cross = await broker.createDraftPull('acme/widgets', { title: 'Cross', head: 'maker/task', base: 'main', head_repo: 'kai/widgets-fork' });
  assert.equal(same.draft, true);
  assert.equal(cross.draft, true);
  assert.equal(transport.calls[0].body.head_repo, undefined);
  assert.equal(transport.calls[1].body.head_repo, 'kai/widgets-fork');
});

test('review inputs and exact-head checks are gathered without collapsing evidence', async () => {
  const transport = routeFetch([
    { path: '/repos/acme/widgets/pulls/5/reviews?per_page=100', data: [{ id: 1, state: 'CHANGES_REQUESTED' }] },
    { path: '/repos/acme/widgets/pulls/5/comments?per_page=100', data: [{ id: 2, path: 'src/a.js' }] },
    { path: '/repos/acme/widgets/issues/5/comments?per_page=100', data: [{ id: 3, body: 'please repair' }] },
    { path: `/repos/acme/widgets/commits/${SHA}/check-runs`, data: { check_runs: [{ id: 4, conclusion: 'success' }] } },
    { path: `/repos/acme/widgets/commits/${SHA}/check-suites`, data: { check_suites: [{ id: 5, conclusion: 'success' }] } },
    { path: `/repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100`, data: { workflow_runs: [{ id: 6, conclusion: 'success' }] } }
  ]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  const review = await broker.listPullReviewInputs('acme/widgets', 5);
  assert.equal(review.reviews.length, 1);
  assert.equal(review.review_comments.length, 1);
  assert.equal(review.issue_comments.length, 1);
  assert.equal(review.receipts.length, 3);
  const checks = await broker.listChecks('acme/widgets', SHA);
  assert.equal(checks.check_runs[0].id, 4);
  assert.equal(checks.check_suites[0].id, 5);
  assert.equal(checks.workflow_runs[0].id, 6);
});

test('authority packets expire, require a human, and hard-confirm destructive actions', () => {
  const clock = () => '2026-07-16T00:00:00.000Z';
  const packet = normalizeAuthorityPacket({
    action: 'repository:create',
    target: 'kai/new-repo',
    issued_by: 'kai',
    nonce: 'one',
    expires_at: '2026-07-16T01:00:00.000Z',
    human_approved: true
  }, { clock });
  assert.match(packet.packet_digest, /^[0-9a-f]{64}$/);
  assert.throws(() => normalizeAuthorityPacket({
    action: 'repository:create', target: 'kai/new-repo', issued_by: 'kai', nonce: 'x', expires_at: '2026-07-15T23:00:00.000Z', human_approved: true
  }, { clock }), /expired/);
  assert.throws(() => normalizeAuthorityPacket({
    action: 'repository:create', target: 'kai/new-repo', issued_by: 'kai', nonce: 'x', expires_at: '2026-07-16T01:00:00.000Z', human_approved: false
  }, { clock }), /human approval/);
  assert.throws(() => normalizeAuthorityPacket({
    action: 'repository:delete', target: 'kai/doomed', issued_by: 'kai', nonce: 'x', expires_at: '2026-07-16T01:00:00.000Z', human_approved: true
  }, { clock }), /exact confirmation/);
  const destructive = normalizeAuthorityPacket({
    action: 'repository:delete', target: 'kai/doomed', issued_by: 'kai', nonce: 'x', expires_at: '2026-07-16T01:00:00.000Z', human_approved: true, confirmation: 'CONFIRM repository:delete kai/doomed'
  }, { clock });
  assert.equal(destructive.action, 'repository:delete');
});

test('repository creation is denied by default and executes only with capability plus matching packet', async () => {
  const transport = routeFetch([
    {
      method: 'POST',
      path: '/user/repos',
      handle: ({ body }) => response(201, { full_name: `kai/${body.name}`, html_url: `https://github.com/kai/${body.name}`, private: body.private })
    }
  ]);
  const clock = () => '2026-07-16T00:00:00.000Z';
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock, retries: 0 });
  const input = { owner: 'kai', owner_type: 'User', name: 'new-repo', private: true, auto_init: true };
  const authority = { action: 'repository:create', target: 'kai/new-repo', issued_by: 'kai', nonce: 'create-1', expires_at: '2026-07-16T01:00:00.000Z', human_approved: true };
  await assert.rejects(broker.executeRepositoryLifecycle('repository:create', input, authority, { capabilities: {} }), /not proven/);
  const receipt = await broker.executeRepositoryLifecycle('repository:create', input, authority, {
    capabilities: { 'repository:create': { state: 'configured', available: true, evidence: 'fine-grained PAT approved by owner' } }
  });
  assert.equal(receipt.action, 'repository:create');
  assert.equal(receipt.repository, 'kai/new-repo');
  assert.equal(receipt.private, true);
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].body.auto_init, true);
});

test('fork and template generation require separate exact authority', async () => {
  const transport = routeFetch([
    { method: 'POST', path: '/repos/acme/widgets/forks', data: { full_name: 'kai/widgets', html_url: 'https://github.com/kai/widgets' }, status: 202 },
    { method: 'POST', path: '/repos/acme/template/generate', data: { full_name: 'kai/generated', html_url: 'https://github.com/kai/generated' }, status: 201 }
  ]);
  const clock = () => '2026-07-16T00:00:00.000Z';
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock, retries: 0 });
  const common = { issued_by: 'kai', expires_at: '2026-07-16T01:00:00.000Z', human_approved: true };
  const fork = await broker.executeRepositoryLifecycle('repository:fork', { target: 'kai/widgets', source_repository: 'acme/widgets', organization: 'kai' }, { ...common, action: 'repository:fork', target: 'kai/widgets', nonce: 'fork' }, { capabilities: { 'repository:fork': { state: 'configured', available: true } } });
  assert.equal(fork.repository, 'kai/widgets');
  const generated = await broker.executeRepositoryLifecycle('repository:template', { target: 'kai/generated', template_repository: 'acme/template', owner: 'kai', name: 'generated' }, { ...common, action: 'repository:template', target: 'kai/generated', nonce: 'template' }, { capabilities: { 'repository:template': { state: 'configured', available: true } } });
  assert.equal(generated.repository, 'kai/generated');
});

test('settings, Pages, environment, secret, and deletion requests remain truthful plans without adapters', async () => {
  const broker = new MakerGitHubBroker({ fetch_impl: async () => { throw new Error('network should not run'); }, clock: () => '2026-07-16T00:00:00.000Z', retries: 0 });
  for (const action of ['branch-protection:replace', 'pages:configure', 'environment:create', 'secret:write', 'repository:delete']) {
    const plan = broker.planRepositoryLifecycle(action, { target: 'acme/widgets', secret_value: 'github_pat_123456789012345678901234567890' });
    assert.equal(plan.executable, false);
    assert.equal(plan.human_gate, true);
    assert.ok(!JSON.stringify(plan).includes('github_pat_'));
    const authority = {
      action,
      target: 'acme/widgets',
      issued_by: 'kai',
      nonce: action,
      expires_at: '2026-07-16T01:00:00.000Z',
      human_approved: true,
      confirmation: `CONFIRM ${action} acme/widgets`
    };
    await assert.rejects(broker.executeRepositoryLifecycle(action, { target: 'acme/widgets' }, authority, {
      capabilities: { [action]: { state: 'configured', available: true } }
    }), /no executable adapter/);
  }
});

test('workflow rerun requests use exact run identity and optional authority packet', async () => {
  const transport = routeFetch([{ method: 'POST', path: '/repos/acme/widgets/actions/runs/99/rerun-failed-jobs', data: null, status: 201 }]);
  const broker = new MakerGitHubBroker({ fetch_impl: transport.fetch, clock: () => '2026-07-16T00:00:00.000Z', retries: 0 });
  const result = await broker.rerunFailedWorkflow('acme/widgets', 99);
  assert.equal(result.run_id, 99);
  assert.equal(result.requested, true);
});

test('broker snapshots and stable digests preserve evidence without credentials', async () => {
  const transport = routeFetch([{ path: '/repos/acme/widgets', data: repoMetadata() }]);
  const token = 'github_pat_123456789012345678901234567890';
  const broker = new MakerGitHubBroker({ credential: { kind: 'fine-grained-pat', token }, fetch_impl: transport.fetch, clock: fixedClock(), retries: 0 });
  await broker.inspectRepository('acme/widgets');
  const snapshot = broker.snapshot();
  assert.equal(snapshot.request_count, 1);
  assert.match(snapshot.snapshot_digest, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes(token));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
