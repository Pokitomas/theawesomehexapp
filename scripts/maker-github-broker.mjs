import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.github.com';
const SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,240}$/;
const KINDS = new Set(['github-actions', 'app-installation', 'fine-grained-pat', 'classic-pat', 'oauth', 'unknown']);
const ACCOUNT_ACTIONS = new Set(['repository:create', 'repository:fork', 'repository:template', 'repository:delete']);
const DESTRUCTIVE_ACTIONS = new Set(['repository:delete', 'branch-protection:replace', 'environment:delete', 'secret:write']);
const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|pat)-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    let output = value;
    for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
    return output;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /token|secret|password|authorization/i.test(key) && typeof child === 'string' ? '[REDACTED]' : redactSecrets(child)]));
}

export function normalizeRepository(value) {
  const repository = clean(value, 300).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!REPOSITORY_RE.test(repository)) throw new Error('Repository must use owner/repository form.');
  const [owner, name] = repository.split('/');
  return Object.freeze({ repository, owner, name });
}

export function normalizeCredential(input = {}) {
  const kind = KINDS.has(clean(input.kind, 80).toLowerCase()) ? clean(input.kind, 80).toLowerCase() : 'unknown';
  const configuredCapabilities = [...new Set((input.configured_capabilities || []).map(value => clean(value, 160)).filter(Boolean))].sort();
  const configuredPermissions = Object.fromEntries(Object.entries(input.configured_permissions || {}).map(([key, value]) => [clean(key, 160), clean(value, 80)]));
  return {
    token: clean(input.token, 20000),
    descriptor: Object.freeze({
      kind,
      actor: clean(input.actor, 200) || null,
      installation_id: Number(input.installation_id) || null,
      owner: clean(input.owner, 200) || null,
      token_present: Boolean(clean(input.token, 20000)),
      configured_capabilities: Object.freeze(configuredCapabilities),
      configured_permissions: Object.freeze(configuredPermissions)
    })
  };
}

function capability(state, available, evidence) {
  if (!['observed', 'configured', 'unknown', 'denied'].includes(state)) throw new Error(`Invalid capability state: ${state}.`);
  return Object.freeze({ state, available: available === null ? null : Boolean(available), evidence: clean(evidence, 1000) || null });
}

function permissionLevel(value) {
  const levels = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
  const normalized = clean(value, 40).toLowerCase();
  return { name: Object.hasOwn(levels, normalized) ? normalized : 'none', level: levels[normalized] || 0 };
}

function retryableStatus(status) {
  return [408, 409, 425, 429].includes(Number(status)) || Number(status) >= 500;
}

function parseLinkHeader(value = '') {
  const links = {};
  for (const part of String(value).split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function safeUrl(value) {
  const url = new URL(value, API);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) if (/token|secret|key|password|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  return url.toString();
}

function authorityAction(value) {
  const action = clean(value, 160).toLowerCase();
  if (!action || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(action)) throw new Error('Authority action is invalid.');
  return action;
}

export function normalizeAuthorityPacket(input = {}, { clock = nowISO } = {}) {
  const action = authorityAction(input.action);
  const target = clean(input.target, 300);
  if (!target) throw new Error('Authority packet requires a target.');
  const issuedBy = clean(input.issued_by, 300);
  const nonce = clean(input.nonce, 300);
  const expiresAt = clean(input.expires_at, 80);
  if (!issuedBy || !nonce || !expiresAt) throw new Error('Authority packet requires issued_by, nonce, and expires_at.');
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(clock());
  if (!Number.isFinite(expiry) || expiry <= current) throw new Error('Authority packet is expired or invalid.');
  if (input.human_approved !== true) throw new Error('Authority packet requires explicit human approval.');
  const packet = {
    schema: 'sideways-maker-github-authority/v1',
    action,
    target,
    issued_by: issuedBy,
    nonce,
    issued_at: clean(input.issued_at, 80) || clock(),
    expires_at: new Date(expiry).toISOString(),
    human_approved: true,
    confirmation: clean(input.confirmation, 500) || null,
    constraints: redactSecrets(input.constraints || {})
  };
  if (DESTRUCTIVE_ACTIONS.has(action) && packet.confirmation !== `CONFIRM ${action} ${target}`) throw new Error(`Destructive authority requires exact confirmation: CONFIRM ${action} ${target}.`);
  return Object.freeze({ ...packet, packet_digest: digest(packet) });
}

export class GitHubBrokerError extends Error {
  constructor(message, { status = null, receipt = null, retryable = false } = {}) {
    super(clean(message, 4000));
    this.name = 'GitHubBrokerError';
    this.status = status;
    this.receipt = receipt;
    this.retryable = retryable;
  }
}

export class MakerGitHubBroker {
  #token;

  constructor({ credential = {}, fetch_impl = fetch, clock = nowISO, sleep = delay, retries = 3, retry_base_ms = 500 } = {}) {
    const normalized = normalizeCredential(credential);
    this.#token = normalized.token;
    this.credential = normalized.descriptor;
    this.fetch = fetch_impl;
    this.clock = clock;
    this.sleep = sleep;
    this.retries = Math.max(0, Math.min(8, Number(retries) || 0));
    this.retryBaseMs = Math.max(1, Number(retry_base_ms) || 500);
    this.requests = [];
    this.idempotency = new Map();
  }

  #headers(extra = {}, idempotencyKey = null) {
    const headers = {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sideways-maker-github-broker',
      ...extra
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return headers;
  }

  async request(method, inputUrl, { body, headers = {}, idempotency_key = null, expected = null } = {}) {
    const verb = clean(method || 'GET', 20).toUpperCase();
    const url = new URL(inputUrl, API);
    if (url.origin !== API) throw new Error('GitHub broker may call only api.github.com.');
    const key = clean(idempotency_key, 300) || null;
    if (key && this.idempotency.has(key)) return this.idempotency.get(key);
    const attemptReceipts = [];
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const startedAt = this.clock();
      try {
        const response = await this.fetch(url, {
          method: verb,
          headers: this.#headers(headers, key),
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        const rate = {
          limit: Number(response.headers?.get?.('x-ratelimit-limit')) || null,
          remaining: Number(response.headers?.get?.('x-ratelimit-remaining')) || null,
          reset: Number(response.headers?.get?.('x-ratelimit-reset')) || null,
          resource: clean(response.headers?.get?.('x-ratelimit-resource'), 120) || null
        };
        const receipt = {
          method: verb,
          url: safeUrl(url),
          status: Number(response.status),
          ok: response.ok,
          request_id: clean(response.headers?.get?.('x-github-request-id'), 200) || null,
          rate_limit: rate,
          oauth_scopes: clean(response.headers?.get?.('x-oauth-scopes'), 1000) || null,
          accepted_oauth_scopes: clean(response.headers?.get?.('x-accepted-oauth-scopes'), 1000) || null,
          started_at: startedAt,
          finished_at: this.clock(),
          attempt: attempt + 1,
          response_digest: digest(redactSecrets(data))
        };
        attemptReceipts.push(receipt);
        if (!response.ok) {
          const error = new GitHubBrokerError(`GitHub API ${response.status}: ${clean(data?.message || data || response.statusText, 2000)}`, {
            status: Number(response.status),
            receipt,
            retryable: retryableStatus(response.status)
          });
          if (!error.retryable || attempt >= this.retries) throw error;
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : this.retryBaseMs * (2 ** attempt);
          await this.sleep(Math.min(15000, Math.max(1, wait)));
          lastError = error;
          continue;
        }
        if (expected && !expected.includes(Number(response.status))) throw new GitHubBrokerError(`Unexpected GitHub response ${response.status}.`, { status: Number(response.status), receipt });
        const result = Object.freeze({ data, response, receipt: Object.freeze({ ...receipt, attempts: Object.freeze(attemptReceipts) }) });
        this.requests.push(result.receipt);
        if (key) this.idempotency.set(key, result);
        return result;
      } catch (error) {
        lastError = error;
        if (error instanceof GitHubBrokerError) {
          if (!error.retryable || attempt >= this.retries) {
            error.receipt = Object.freeze({ ...(error.receipt || {}), attempts: Object.freeze(attemptReceipts) });
            this.requests.push(error.receipt);
            throw error;
          }
        } else if (attempt >= this.retries) {
          const receipt = { method: verb, url: safeUrl(url), status: null, ok: false, started_at: startedAt, finished_at: this.clock(), attempt: attempt + 1, error: clean(error?.message || error, 2000), attempts: attemptReceipts };
          this.requests.push(receipt);
          throw new GitHubBrokerError(receipt.error, { receipt, retryable: true });
        }
        await this.sleep(Math.min(15000, this.retryBaseMs * (2 ** attempt)));
      }
    }
    throw lastError || new GitHubBrokerError('GitHub request failed.');
  }

  async paginate(inputUrl, { per_page = 100, max_items = 1000 } = {}) {
    let url = new URL(inputUrl, API);
    url.searchParams.set('per_page', String(Math.max(1, Math.min(100, Number(per_page) || 100))));
    const items = [];
    const receipts = [];
    while (url && items.length < max_items) {
      const result = await this.request('GET', url);
      if (!Array.isArray(result.data)) throw new Error('Paginated GitHub response was not an array.');
      items.push(...result.data.slice(0, max_items - items.length));
      receipts.push(result.receipt);
      const next = parseLinkHeader(result.response.headers?.get?.('link')).next;
      url = next ? new URL(next) : null;
    }
    return Object.freeze({ items: Object.freeze(items), receipts: Object.freeze(receipts), truncated: items.length >= max_items });
  }

  async inspectRepository(repository) {
    const target = normalizeRepository(repository);
    const result = await this.request('GET', `/repos/${target.owner}/${target.name}`);
    const permission = permissionLevel(result.data?.role_name || (result.data?.permissions?.admin ? 'admin' : result.data?.permissions?.maintain ? 'maintain' : result.data?.permissions?.push ? 'write' : result.data?.permissions?.triage ? 'triage' : result.data?.permissions?.pull ? 'read' : 'none'));
    return Object.freeze({
      repository: target.repository,
      exists: true,
      visible: true,
      permission: permission.name,
      default_branch: clean(result.data?.default_branch || 'main', 200),
      archived: result.data?.archived === true,
      disabled: result.data?.disabled === true,
      fork: result.data?.fork === true,
      private: result.data?.private === true,
      owner_type: clean(result.data?.owner?.type, 80) || null,
      permissions: redactSecrets(result.data?.permissions || {}),
      source: 'github-api',
      receipt: result.receipt
    });
  }

  async discoverCapabilities(repository) {
    const metadata = await this.inspectRepository(repository);
    const permission = permissionLevel(metadata.permission);
    const configured = new Set(this.credential.configured_capabilities);
    const scopes = this.requests.at(-1)?.oauth_scopes?.split(',').map(value => value.trim()).filter(Boolean) || [];
    const observedScopes = new Set(scopes);
    const repoWrite = permission.level >= permissionLevel('write').level;
    const capabilities = {
      'repository:read': capability('observed', true, `repository metadata visible with ${permission.name} permission`),
      'contents:write': capability('observed', repoWrite, `repository permission=${permission.name}`),
      'issues:write': configured.has('issues:write') ? capability('configured', true, 'credential configured capability') : capability('unknown', null, 'repository metadata does not expose issue-token permission'),
      'pull-requests:write': configured.has('pull-requests:write') ? capability('configured', true, 'credential configured capability') : capability('unknown', null, 'repository metadata does not expose pull-request-token permission'),
      'actions:read': configured.has('actions:read') ? capability('configured', true, 'credential configured capability') : capability('unknown', null, 'not probed'),
      'actions:write': configured.has('actions:write') ? capability('configured', true, 'credential configured capability') : capability('unknown', null, 'not probed'),
      'administration:write': configured.has('administration:write') ? capability('configured', true, 'explicit credential configuration') : capability('unknown', null, 'not probed'),
      'repository:create': configured.has('repository:create') ? capability('configured', true, 'explicit account-level credential configuration') : capability(this.credential.kind === 'github-actions' ? 'denied' : 'unknown', this.credential.kind === 'github-actions' ? false : null, this.credential.kind === 'github-actions' ? 'repository GITHUB_TOKEN is repository-scoped' : 'account-level permission not proven'),
      'repository:fork': configured.has('repository:fork') ? capability('configured', true, 'explicit account-level credential configuration') : capability('unknown', null, 'not proven'),
      'repository:template': configured.has('repository:template') ? capability('configured', true, 'explicit account-level credential configuration') : capability('unknown', null, 'not proven'),
      'repository:delete': configured.has('repository:delete') ? capability('configured', true, 'explicit destructive credential configuration') : capability('denied', false, 'destructive capability denied by default')
    };
    for (const scope of observedScopes) capabilities[`oauth-scope:${scope}`] = capability('observed', true, 'x-oauth-scopes response header');
    const body = { schema: 'sideways-maker-github-capabilities/v1', repository: metadata.repository, credential: this.credential, metadata: { permission: metadata.permission, private: metadata.private, archived: metadata.archived, disabled: metadata.disabled }, capabilities, observed_at: this.clock() };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }

  async resolveRef(repository, revision = 'main') {
    const target = normalizeRepository(repository);
    const ref = clean(revision || 'main', 240);
    if (SHA_RE.test(ref)) {
      const commit = await this.request('GET', `/repos/${target.owner}/${target.name}/commits/${ref}`);
      const sha = clean(commit.data?.sha, 40).toLowerCase();
      if (sha !== ref.toLowerCase()) throw new Error('GitHub commit response did not preserve the requested SHA.');
      return Object.freeze({ repository: target.repository, requested: ref, sha, kind: 'commit', receipt: commit.receipt });
    }
    if (!REF_RE.test(ref) || ref.includes('..') || ref.includes('@{')) throw new Error('GitHub revision is invalid.');
    const commit = await this.request('GET', `/repos/${target.owner}/${target.name}/commits/${encodeURIComponent(ref)}`);
    const sha = clean(commit.data?.sha, 40).toLowerCase();
    if (!SHA_RE.test(sha)) throw new Error('GitHub revision did not resolve to an exact commit SHA.');
    return Object.freeze({ repository: target.repository, requested: ref, sha, kind: 'ref', receipt: commit.receipt });
  }

  async createBranch(repository, { branch, sha, idempotency_key } = {}) {
    const target = normalizeRepository(repository);
    const name = clean(branch, 240);
    if (!REF_RE.test(name) || name.includes('..') || name.includes('@{')) throw new Error('Branch name is invalid.');
    if (!SHA_RE.test(clean(sha, 40))) throw new Error('Branch creation requires an exact commit SHA.');
    const result = await this.request('POST', `/repos/${target.owner}/${target.name}/git/refs`, {
      body: { ref: `refs/heads/${name}`, sha: clean(sha, 40).toLowerCase() },
      idempotency_key: idempotency_key || `branch:${target.repository}:${name}:${sha}`,
      expected: [201]
    });
    return Object.freeze({ repository: target.repository, branch: name, sha: clean(result.data?.object?.sha || sha, 40).toLowerCase(), receipt: result.receipt });
  }

  async createIssue(repository, { title, body = '', labels = [], assignees = [], idempotency_key } = {}) {
    const target = normalizeRepository(repository);
    const result = await this.request('POST', `/repos/${target.owner}/${target.name}/issues`, {
      body: { title: clean(title, 256), body: clean(body, 60000), labels: labels.map(value => clean(value, 100)), assignees: assignees.map(value => clean(value, 100)) },
      idempotency_key,
      expected: [201]
    });
    return Object.freeze({ repository: target.repository, number: Number(result.data?.number), url: clean(result.data?.html_url, 1000), receipt: result.receipt });
  }

  async comment(repository, number, body, { idempotency_key } = {}) {
    const target = normalizeRepository(repository);
    const result = await this.request('POST', `/repos/${target.owner}/${target.name}/issues/${Number(number)}/comments`, {
      body: { body: clean(redactSecrets(body), 60000) },
      idempotency_key,
      expected: [201]
    });
    return Object.freeze({ repository: target.repository, issue: Number(number), comment_id: Number(result.data?.id), url: clean(result.data?.html_url, 1000), receipt: result.receipt });
  }

  async createDraftPull(repository, { title, body = '', head, base, head_repo = null, maintainer_can_modify = true, idempotency_key } = {}) {
    const target = normalizeRepository(repository);
    if (!REF_RE.test(clean(head, 240)) || !REF_RE.test(clean(base, 240))) throw new Error('Pull request head and base are invalid.');
    const payload = { title: clean(title, 256), body: clean(redactSecrets(body), 60000), head: clean(head, 240), base: clean(base, 240), draft: true, maintainer_can_modify: maintainer_can_modify !== false };
    if (head_repo) payload.head_repo = normalizeRepository(head_repo).repository;
    const result = await this.request('POST', `/repos/${target.owner}/${target.name}/pulls`, { body: payload, idempotency_key, expected: [201] });
    return Object.freeze({ repository: target.repository, number: Number(result.data?.number), url: clean(result.data?.html_url, 1000), head_sha: clean(result.data?.head?.sha, 40).toLowerCase() || null, base_sha: clean(result.data?.base?.sha, 40).toLowerCase() || null, draft: result.data?.draft === true, receipt: result.receipt });
  }

  async listPullReviewInputs(repository, pullNumber) {
    const target = normalizeRepository(repository);
    const [reviews, comments, issueComments] = await Promise.all([
      this.paginate(`/repos/${target.owner}/${target.name}/pulls/${Number(pullNumber)}/reviews`),
      this.paginate(`/repos/${target.owner}/${target.name}/pulls/${Number(pullNumber)}/comments`),
      this.paginate(`/repos/${target.owner}/${target.name}/issues/${Number(pullNumber)}/comments`)
    ]);
    return Object.freeze({ repository: target.repository, pull_request: Number(pullNumber), reviews: reviews.items, review_comments: comments.items, issue_comments: issueComments.items, receipts: Object.freeze([...reviews.receipts, ...comments.receipts, ...issueComments.receipts]) });
  }

  async listChecks(repository, ref) {
    const target = normalizeRepository(repository);
    const value = clean(ref, 240);
    if (!REF_RE.test(value)) throw new Error('Check ref is invalid.');
    const [runs, suites, workflows] = await Promise.all([
      this.request('GET', `/repos/${target.owner}/${target.name}/commits/${encodeURIComponent(value)}/check-runs`, { headers: { accept: 'application/vnd.github+json' } }),
      this.request('GET', `/repos/${target.owner}/${target.name}/commits/${encodeURIComponent(value)}/check-suites`, { headers: { accept: 'application/vnd.github+json' } }),
      this.request('GET', `/repos/${target.owner}/${target.name}/actions/runs?head_sha=${encodeURIComponent(value)}&per_page=100`)
    ]);
    return Object.freeze({ repository: target.repository, ref: value, check_runs: runs.data?.check_runs || [], check_suites: suites.data?.check_suites || [], workflow_runs: workflows.data?.workflow_runs || [], receipts: Object.freeze([runs.receipt, suites.receipt, workflows.receipt]) });
  }

  async rerunFailedWorkflow(repository, runId, authority = null) {
    const target = normalizeRepository(repository);
    if (authority) normalizeAuthorityPacket(authority, { clock: this.clock });
    const result = await this.request('POST', `/repos/${target.owner}/${target.name}/actions/runs/${Number(runId)}/rerun-failed-jobs`, { expected: [201] });
    return Object.freeze({ repository: target.repository, run_id: Number(runId), requested: true, receipt: result.receipt });
  }

  planRepositoryLifecycle(actionInput, input = {}) {
    const action = authorityAction(actionInput);
    if (!ACCOUNT_ACTIONS.has(action) && !action.startsWith('repository:') && !action.startsWith('branch-protection:') && !action.startsWith('pages:') && !action.startsWith('environment:') && !action.startsWith('secret:')) throw new Error(`Unsupported repository lifecycle action: ${action}.`);
    const target = clean(input.target || input.repository || `${clean(input.owner, 200)}/${clean(input.name, 200)}`, 300).replace(/^\/$/, '');
    const body = {
      schema: 'sideways-maker-github-lifecycle-plan/v1',
      action,
      target,
      request: redactSecrets(input),
      executable: false,
      required_capability: action,
      required_authority_packet: true,
      human_gate: true,
      generated_at: this.clock()
    };
    return Object.freeze({ ...body, plan_digest: digest(body) });
  }

  async executeRepositoryLifecycle(actionInput, input = {}, authorityInput = {}, capabilitiesInput = null) {
    const action = authorityAction(actionInput);
    const authority = normalizeAuthorityPacket(authorityInput, { clock: this.clock });
    const target = clean(input.target || input.repository || `${clean(input.owner, 200)}/${clean(input.name, 200)}`, 300).replace(/^\/$/, '');
    if (authority.action !== action || authority.target !== target) throw new Error('Authority packet does not match the requested lifecycle action and target.');
    const capabilities = capabilitiesInput || { capabilities: {} };
    const proof = capabilities.capabilities?.[action];
    if (!proof || proof.available !== true || !['observed', 'configured'].includes(proof.state)) throw new Error(`Credential capability is not proven for ${action}.`);
    if (action === 'repository:create') {
      const owner = clean(input.owner, 200);
      const name = clean(input.name, 100);
      if (!owner || !name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Repository creation requires owner and valid name.');
      const endpoint = input.owner_type === 'Organization' ? `/orgs/${owner}/repos` : '/user/repos';
      const result = await this.request('POST', endpoint, {
        body: {
          name,
          description: clean(input.description, 1000),
          private: input.private !== false,
          auto_init: input.auto_init === true,
          gitignore_template: clean(input.gitignore_template, 100) || undefined,
          license_template: clean(input.license_template, 100) || undefined,
          has_issues: input.has_issues !== false,
          has_projects: input.has_projects === true,
          has_wiki: input.has_wiki === true,
          is_template: input.is_template === true
        },
        idempotency_key: `repository:create:${owner}/${name}:${authority.nonce}`,
        expected: [201]
      });
      const receiptBody = { schema: 'sideways-maker-github-lifecycle-receipt/v1', action, target, authority_digest: authority.packet_digest, repository: clean(result.data?.full_name || `${owner}/${name}`, 300), url: clean(result.data?.html_url, 1000), private: result.data?.private === true, request: result.receipt, executed_at: this.clock() };
      return Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
    }
    if (action === 'repository:fork') {
      const source = normalizeRepository(input.source_repository);
      const result = await this.request('POST', `/repos/${source.owner}/${source.name}/forks`, { body: { organization: clean(input.organization, 200) || undefined, name: clean(input.name, 100) || undefined, default_branch_only: input.default_branch_only !== false }, idempotency_key: `repository:fork:${source.repository}:${authority.nonce}`, expected: [202] });
      const receiptBody = { schema: 'sideways-maker-github-lifecycle-receipt/v1', action, target, authority_digest: authority.packet_digest, repository: clean(result.data?.full_name, 300), url: clean(result.data?.html_url, 1000), request: result.receipt, executed_at: this.clock() };
      return Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
    }
    if (action === 'repository:template') {
      const source = normalizeRepository(input.template_repository);
      const result = await this.request('POST', `/repos/${source.owner}/${source.name}/generate`, { body: { owner: clean(input.owner, 200), name: clean(input.name, 100), description: clean(input.description, 1000), include_all_branches: input.include_all_branches === true, private: input.private !== false }, idempotency_key: `repository:template:${source.repository}:${authority.nonce}`, expected: [201] });
      const receiptBody = { schema: 'sideways-maker-github-lifecycle-receipt/v1', action, target, authority_digest: authority.packet_digest, repository: clean(result.data?.full_name, 300), url: clean(result.data?.html_url, 1000), request: result.receipt, executed_at: this.clock() };
      return Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
    }
    throw new Error(`${action} is represented as a human-gated plan but has no executable adapter.`);
  }

  snapshot() {
    const body = { schema: 'sideways-maker-github-broker-snapshot/v1', credential: this.credential, request_count: this.requests.length, requests: this.requests.map(redactSecrets), captured_at: this.clock() };
    return Object.freeze({ ...body, snapshot_digest: digest(body) });
  }
}
