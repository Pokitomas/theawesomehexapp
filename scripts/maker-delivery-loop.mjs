import crypto from 'node:crypto';

export const DELIVERY_LOOP_SCHEMA = 'sideways-maker-delivery-loop/v1';
export const DELIVERY_RECEIPT_SCHEMA = 'sideways-maker-delivery-receipt/v1';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const SECRET_KEY = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential)(?:$|[_-])/i;

export function redactDeliveryEvidence(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactDeliveryEvidence(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [
    clean(key, 300), SECRET_KEY.test(key) ? '[redacted]' : redactDeliveryEvidence(item, depth + 1)
  ]));
  if (typeof value === 'string') return clean(value.replace(SECRET, '[redacted]'));
  return value;
}

function id(prefix, value) { return `${prefix}_${digest(value).slice(0, 20)}`; }
function now(clock) { return new Date(clock()).toISOString(); }
function assertSha(value, label = 'head SHA') {
  const sha = clean(value, 80).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a 40-character SHA.`);
  return sha;
}

export function normalizeDeliveryCheck(value = {}, expectedHead = '') {
  const head = clean(value.head_sha || value.sha || expectedHead, 80).toLowerCase();
  const raw = clean(value.conclusion ?? value.state ?? value.status, 80).toLowerCase();
  let state = 'pending';
  if (['success', 'passed', 'pass', 'neutral', 'skipped'].includes(raw)) state = 'success';
  else if (['failure', 'failed', 'error', 'timed_out', 'startup_failure'].includes(raw)) state = 'failure';
  else if (['cancelled', 'canceled'].includes(raw)) state = 'cancelled';
  else if (['action_required', 'blocked'].includes(raw)) state = 'blocked';
  else if (['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(raw)) state = 'pending';
  return Object.freeze({
    schema: 'sideways-maker-delivery-check/v1',
    id: clean(value.id || id('check', [value.name, head, value.url]), 300),
    name: clean(value.name || value.context || value.workflow || 'unnamed-check', 300),
    provider: clean(value.provider || value.source || (value.external ? 'external' : 'github-actions'), 120),
    state,
    head_sha: head,
    url: clean(value.url || value.details_url || value.html_url, 2000),
    job_id: clean(value.job_id || '', 200),
    run_id: clean(value.run_id || '', 200),
    started_at: clean(value.started_at || '', 100),
    completed_at: clean(value.completed_at || '', 100),
    evidence: redactDeliveryEvidence(value.evidence || value.output || value.message || '')
  });
}

export function classifyDeliveryFailure(check = {}, evidence = '') {
  const text = `${clean(check.name)} ${clean(check.state)} ${clean(check.evidence)} ${clean(evidence)}`.toLowerCase();
  if (/rate.?limit|429|flaky|intermittent|runner lost|temporar/.test(text)) return 'flaky-retryable';
  if (/permission|forbidden|unauthori[sz]ed|scope|credential/.test(text)) return 'permissions';
  if (/secret|missing config|configuration|environment variable|token/.test(text)) return 'secrets-configuration';
  if (/service unavailable|gateway|dns|network|external|outage/.test(text)) return 'external-service';
  if (/policy|authority|manifest|protected branch|approval required/.test(text)) return 'policy';
  if (/runner|node version|os |environment|dependency install|disk|memory/.test(text)) return 'environment';
  if (/test|lint|typecheck|compile|build|assert|syntax|diff/.test(text)) return 'code-local';
  return 'unknown';
}

export function normalizeReviewEvent(value = {}) {
  const type = clean(value.type || value.kind || value.event || 'comment', 100).toLowerCase();
  const body = clean(value.body || value.comment || value.review || value.command, 12000);
  const state = clean(value.state || value.review_state || '', 80).toLowerCase();
  const resolved = value.resolved === true || state === 'resolved';
  const actionable = !resolved && (
    ['changes_requested', 'requested_changes', 'review_thread', 'human_command'].includes(type)
    || state === 'changes_requested'
    || /^\s*(?:please|fix|change|remove|add|rerun|resolve|update)\b/i.test(body)
  );
  const event = {
    schema: 'sideways-maker-review-event/v1',
    id: clean(value.id || value.comment_id || value.thread_id || id('review', [type, body, value.path, value.line]), 300),
    type,
    state,
    author: clean(value.author || value.user || '', 300),
    body: redactDeliveryEvidence(body),
    path: clean(value.path || '', 1000),
    line: Number.isInteger(Number(value.line)) ? Number(value.line) : null,
    resolved,
    actionable,
    url: clean(value.url || '', 2000),
    created_at: clean(value.created_at || '', 100)
  };
  return Object.freeze(event);
}

function authorityAllows(packet, environment) {
  const env = clean(environment, 100).toLowerCase();
  if (!packet || packet.schema !== 'sideways-maker-deployment-authority/v1') return false;
  if (packet.expires_at && Date.parse(packet.expires_at) <= Date.now()) return false;
  return Array.isArray(packet.environments) && packet.environments.map(value => clean(value, 100).toLowerCase()).includes(env)
    && packet.human_approved === true;
}

function receiptBody(state) {
  const body = {
    schema: DELIVERY_RECEIPT_SCHEMA,
    repository: state.repository,
    branch: state.branch,
    pr_number: state.pr_number,
    head_sha: state.head_sha,
    status: state.status,
    required_checks: state.required_checks,
    checks: state.checks,
    check_history: state.check_history,
    repairs: state.repairs,
    reviews: state.reviews,
    releases: state.releases,
    deployments: state.deployments,
    cursor: state.cursor,
    cancellation: state.cancellation,
    events: state.events
  };
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}

export class MakerDeliveryLoop {
  constructor({ repository, branch, pr_number, head_sha, required_checks = [], transport = {}, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), state = null } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean(repository))) throw new Error('repository must be owner/name.');
    this.transport = transport;
    this.clock = clock;
    this.sleep = sleep;
    this.state = state ? structuredClone(state) : {
      schema: DELIVERY_LOOP_SCHEMA,
      repository: clean(repository), branch: clean(branch, 300), pr_number: Number(pr_number), head_sha: assertSha(head_sha),
      status: 'observing', required_checks: [...new Set(required_checks.map(value => clean(value, 300)).filter(Boolean))].sort(),
      checks: [], check_history: [], repairs: [], reviews: [], releases: [], deployments: [], events: [], cursor: null, cancellation: null
    };
    if (this.state.schema !== DELIVERY_LOOP_SCHEMA) throw new Error('Unsupported delivery loop state.');
  }

  #event(type, detail = {}) {
    const event = { sequence: this.state.events.length + 1, type, at: now(this.clock), detail: redactDeliveryEvidence(detail) };
    this.state.events.push({ ...event, event_digest: digest(event) });
    this.state.cursor = this.state.events.at(-1).event_digest;
    return event;
  }

  snapshot() { return structuredClone(this.state); }
  receipt() { return receiptBody(this.state); }
  cancel(reason = 'operator-cancelled') { this.state.cancellation = { reason: clean(reason, 1000), at: now(this.clock) }; this.state.status = 'cancelled'; this.#event('cancelled', this.state.cancellation); return this.receipt(); }
  resume() { if (this.state.status !== 'cancelled') return this.receipt(); this.state.status = 'observing'; this.#event('resumed', { previous: this.state.cancellation }); this.state.cancellation = null; return this.receipt(); }

  observeChecks(values, { head_sha = this.state.head_sha } = {}) {
    const observedHead = assertSha(head_sha, 'observed check head SHA');
    const normalized = (Array.isArray(values) ? values : []).map(value => normalizeDeliveryCheck(value, observedHead));
    const stale = normalized.filter(check => check.head_sha && check.head_sha !== this.state.head_sha);
    if (stale.length) {
      this.#event('stale_checks_rejected', { expected_head: this.state.head_sha, stale: stale.map(check => ({ id: check.id, head_sha: check.head_sha })) });
      throw new Error('Stale check success cannot satisfy the current exact head.');
    }
    this.state.checks = normalized;
    this.state.check_history.push({ head_sha: this.state.head_sha, observed_at: now(this.clock), checks: normalized });
    const byName = new Map(normalized.map(check => [check.name, check]));
    const missing = this.state.required_checks.filter(name => !byName.has(name));
    const failing = normalized.filter(check => check.state === 'failure' || check.state === 'blocked' || check.state === 'cancelled');
    const pending = normalized.filter(check => check.state === 'pending');
    if (failing.length) this.state.status = 'repair_required';
    else if (missing.length || pending.length) this.state.status = 'observing';
    else this.state.status = 'checks_green';
    this.#event('checks_observed', { head_sha: this.state.head_sha, missing, failing: failing.map(check => check.name), pending: pending.map(check => check.name) });
    return Object.freeze({ status: this.state.status, missing, failing, pending, checks: normalized });
  }

  async pollChecks({ max_attempts = 8, base_delay_ms = 10, max_delay_ms = 5000 } = {}) {
    if (typeof this.transport.listChecks !== 'function') throw new Error('listChecks transport is unavailable.');
    let attempt = 0;
    while (attempt < max_attempts) {
      if (this.state.status === 'cancelled') return this.receipt();
      attempt += 1;
      try {
        const values = await this.transport.listChecks({ repository: this.state.repository, pr_number: this.state.pr_number, head_sha: this.state.head_sha, cursor: this.state.cursor });
        const observed = this.observeChecks(values, { head_sha: this.state.head_sha });
        if (['checks_green', 'repair_required'].includes(observed.status)) return observed;
      } catch (error) {
        const message = clean(error?.message || error, 4000);
        const retryable = Number(error?.status) === 429 || /rate.?limit|temporar|timeout/i.test(message);
        this.#event('check_poll_error', { attempt, retryable, message });
        if (!retryable || attempt >= max_attempts) throw error;
      }
      const delay = Math.min(max_delay_ms, base_delay_ms * 2 ** (attempt - 1));
      await this.sleep(delay);
    }
    throw new Error('Check polling exhausted its bounded attempt budget.');
  }

  async collectFailureEvidence(checkId, { max_log_bytes = 24000, max_artifacts = 20 } = {}) {
    const check = this.state.checks.find(item => item.id === checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}.`);
    const logs = typeof this.transport.fetchLogs === 'function' ? await this.transport.fetchLogs(check) : '';
    const artifacts = typeof this.transport.listArtifacts === 'function' ? await this.transport.listArtifacts(check) : [];
    const evidence = {
      logs: redactDeliveryEvidence(clean(logs, max_log_bytes)),
      artifacts: redactDeliveryEvidence((Array.isArray(artifacts) ? artifacts : []).slice(0, max_artifacts)),
      classification: classifyDeliveryFailure(check, logs)
    };
    this.#event('failure_evidence_collected', { check_id: check.id, classification: evidence.classification });
    return Object.freeze(evidence);
  }

  createRepairAssignment(checkId, evidence = {}) {
    const check = this.state.checks.find(item => item.id === checkId);
    if (!check || !['failure', 'blocked', 'cancelled'].includes(check.state)) throw new Error('Repair assignment requires a failing check.');
    const assignment = {
      schema: 'sideways-maker-repair-assignment/v1', id: id('repair', [this.state.head_sha, check.id, this.state.repairs.length]),
      source_head_sha: this.state.head_sha, check_id: check.id, check_name: check.name,
      classification: evidence.classification || classifyDeliveryFailure(check, evidence.logs),
      files: [...new Set((evidence.files || []).map(value => clean(value, 1000)).filter(Boolean))],
      tests: [...new Set((evidence.tests || [check.name]).map(value => clean(value, 1000)).filter(Boolean))],
      evidence: redactDeliveryEvidence(evidence), status: 'assigned', created_at: now(this.clock), attempts: []
    };
    this.state.repairs.push(assignment); this.state.status = 'repairing'; this.#event('repair_assigned', assignment); return Object.freeze(structuredClone(assignment));
  }

  recordRepair({ assignment_id, new_head_sha, summary = '', changed_paths = [], verification = [] } = {}) {
    const assignment = this.state.repairs.find(item => item.id === assignment_id);
    if (!assignment) throw new Error(`Unknown repair assignment: ${assignment_id}.`);
    const nextHead = assertSha(new_head_sha, 'repair head SHA');
    if (nextHead === this.state.head_sha) throw new Error('Repair must produce a new exact head.');
    const attempt = { attempt: assignment.attempts.length + 1, prior_head_sha: this.state.head_sha, new_head_sha: nextHead, summary: clean(summary, 4000), changed_paths: changed_paths.map(value => clean(value, 1000)), verification: redactDeliveryEvidence(verification), at: now(this.clock) };
    assignment.attempts.push(attempt); assignment.status = 'awaiting_exact_head_checks';
    this.state.head_sha = nextHead; this.state.checks = []; this.state.status = 'observing';
    this.#event('repair_recorded', attempt); return Object.freeze(structuredClone(attempt));
  }

  ingestReviews(values = []) {
    const existing = new Set(this.state.reviews.map(item => item.id));
    const added = [];
    for (const value of values) {
      const event = normalizeReviewEvent(value);
      if (existing.has(event.id)) continue;
      existing.add(event.id); this.state.reviews.push(structuredClone(event)); added.push(event);
    }
    this.#event('reviews_ingested', { added: added.map(item => item.id), actionable: added.filter(item => item.actionable).map(item => item.id) });
    return Object.freeze(added);
  }

  resolveReview(idValue, evidence = '') {
    const event = this.state.reviews.find(item => item.id === idValue);
    if (!event) throw new Error(`Unknown review event: ${idValue}.`);
    event.resolved = true; event.actionable = false; event.resolution_evidence = redactDeliveryEvidence(evidence); event.resolved_at = now(this.clock);
    this.#event('review_resolved', { id: event.id, evidence }); return Object.freeze(structuredClone(event));
  }

  gate() {
    const byName = new Map(this.state.checks.map(check => [check.name, check]));
    const missing = this.state.required_checks.filter(name => !byName.has(name));
    const notGreen = this.state.required_checks.filter(name => byName.get(name)?.state !== 'success');
    const unresolved = this.state.reviews.filter(item => item.actionable && !item.resolved);
    const ready = this.state.status === 'checks_green' && !missing.length && !notGreen.length && !unresolved.length && !this.state.cancellation;
    return Object.freeze({ ready, exact_head_sha: this.state.head_sha, missing_checks: missing, non_green_checks: notGreen, unresolved_reviews: unresolved.map(item => item.id), transition: ready ? 'ready_for_review' : 'draft' });
  }

  prepareRelease({ version, notes = [], migrations = [], rollback = [] } = {}) {
    const gate = this.gate();
    if (!gate.ready) throw new Error('Release preparation requires exact-head green checks and resolved review feedback.');
    const body = { schema: 'sideways-maker-release-receipt/v1', repository: this.state.repository, pr_number: this.state.pr_number, head_sha: this.state.head_sha, version: clean(version, 200), notes: notes.map(value => clean(value, 4000)), migrations: redactDeliveryEvidence(migrations), rollback: redactDeliveryEvidence(rollback), prepared_at: now(this.clock) };
    const release = { ...body, release_digest: digest(body) }; this.state.releases.push(release); this.#event('release_prepared', release); return Object.freeze(structuredClone(release));
  }

  requestDeployment({ environment, mode = 'dry-run', authority_packet = null, expected_sentinel = null, release_digest = null } = {}) {
    const env = clean(environment || 'preview', 100).toLowerCase();
    const selectedMode = clean(mode, 40).toLowerCase();
    if (!['dry-run', 'preview', 'canary', 'production'].includes(selectedMode)) throw new Error('Unsupported deployment mode.');
    const authorized = selectedMode === 'dry-run' || authorityAllows(authority_packet, env);
    const request = {
      schema: 'sideways-maker-deployment-request/v1', id: id('deploy', [this.state.head_sha, env, selectedMode, this.state.deployments.length]),
      repository: this.state.repository, head_sha: this.state.head_sha, environment: env, mode: selectedMode,
      release_digest: clean(release_digest || this.state.releases.at(-1)?.release_digest, 200),
      expected_sentinel: redactDeliveryEvidence(expected_sentinel), authorized, status: authorized ? 'requested' : 'blocked_authority', requested_at: now(this.clock)
    };
    this.state.deployments.push(request); this.#event('deployment_requested', request); return Object.freeze(structuredClone(request));
  }

  verifyDeployment({ request_id, observed_sentinel, monitoring = [] } = {}) {
    const request = this.state.deployments.find(item => item.id === request_id);
    if (!request) throw new Error(`Unknown deployment request: ${request_id}.`);
    if (!request.authorized) throw new Error('Deployment request is not authorized.');
    const expected = stable(request.expected_sentinel ?? null);
    const observed = stable(redactDeliveryEvidence(observed_sentinel));
    request.observed_sentinel = redactDeliveryEvidence(observed_sentinel); request.monitoring = redactDeliveryEvidence(monitoring);
    request.status = expected === observed ? 'verified' : 'sentinel_mismatch'; request.verified_at = now(this.clock);
    this.#event('deployment_verified', { request_id, status: request.status }); return Object.freeze(structuredClone(request));
  }

  requestRollback({ request_id, reason, authority_packet = null } = {}) {
    const request = this.state.deployments.find(item => item.id === request_id);
    if (!request) throw new Error(`Unknown deployment request: ${request_id}.`);
    const authorized = authorityAllows(authority_packet, request.environment);
    const rollback = { schema: 'sideways-maker-rollback-request/v1', id: id('rollback', [request_id, reason]), deployment_request_id: request_id, environment: request.environment, reason: clean(reason, 4000), authorized, status: authorized ? 'requested' : 'blocked_authority', requested_at: now(this.clock) };
    request.rollback = rollback; this.#event('rollback_requested', rollback); return Object.freeze(structuredClone(rollback));
  }
}

export function createMakerDeliveryLoop(options) { return new MakerDeliveryLoop(options); }
