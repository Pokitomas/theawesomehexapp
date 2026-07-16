import crypto from 'node:crypto';

const SECRET_KEYS = /(?:authorization|token|secret|password|private[_-]?key|api[_-]?key|cookie)/i;
const SECRET_VALUES = /(?:bearer\s+[a-z0-9._-]{12,}|gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{16,})/ig;
const CHECK_STATES = new Set(['queued','running','success','failure','cancelled','skipped','neutral','unknown']);
const FAILURE_CLASSES = new Set(['code_local','flaky_retryable','external_service','permissions','secrets_configuration','environment','policy','unknown']);

export const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
};

export const deliveryDigest = value =>
  crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export const redactDeliverySecrets = value => {
  if (Array.isArray(value)) return value.map(redactDeliverySecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS.test(key) ? '[redacted]' : redactDeliverySecrets(item)
    ]));
  }
  return typeof value === 'string' ? value.replace(SECRET_VALUES, '[redacted]') : value;
};

const clean = (value, max = 2000) => String(value ?? '').replace(/\0/g, '').slice(0, max);
const nowIso = clock => new Date(clock()).toISOString();

export function normalizeCheck(input = {}, headSha) {
  const raw = clean(input.conclusion || input.status || input.state || 'unknown', 100).toLowerCase();
  let state = 'unknown';
  if (['completed','success','successful','passed','pass','green'].includes(raw)) state = 'success';
  else if (['failure','failed','error','timed_out','action_required','red'].includes(raw)) state = 'failure';
  else if (['queued','pending','waiting','requested'].includes(raw)) state = 'queued';
  else if (['in_progress','running','started'].includes(raw)) state = 'running';
  else if (['cancelled','canceled'].includes(raw)) state = 'cancelled';
  else if (['skipped'].includes(raw)) state = 'skipped';
  else if (['neutral'].includes(raw)) state = 'neutral';
  else if (CHECK_STATES.has(raw)) state = raw;
  const record = {
    schema: 'sideways-maker-delivery-check/v1',
    id: clean(input.id || input.external_id || input.name || 'unknown', 300),
    name: clean(input.name || input.context || input.id || 'Unnamed check', 300),
    provider: clean(input.provider || input.source || 'github', 100),
    state,
    head_sha: clean(input.head_sha || input.sha || headSha || '', 64),
    started_at: input.started_at || null,
    completed_at: input.completed_at || null,
    url: clean(input.url || input.html_url || input.details_url || '', 2000),
    evidence: redactDeliverySecrets(input.evidence || input.output || input.detail || {}),
  };
  record.digest = deliveryDigest(record);
  return record;
}

export function classifyFailure(check = {}, log = '') {
  const text = `${check.name || ''}\n${JSON.stringify(check.evidence || {})}\n${log || ''}`.toLowerCase();
  let classification = 'unknown';
  if (/(permission denied|forbidden|not authorized|resource not accessible|http 403)/.test(text)) classification = 'permissions';
  else if (/(secret|credential|missing env|configuration|config\b|api key|token required)/.test(text)) classification = 'secrets_configuration';
  else if (/(policy|authority manifest|protected path|lease|forbidden action|supply chain)/.test(text)) classification = 'policy';
  else if (/(rate limit|http 429|timeout|connection reset|service unavailable|http 5\d\d|dns|network)/.test(text)) classification = 'external_service';
  else if (/(flaky|intermittent|rerun|retryable|race condition)/.test(text)) classification = 'flaky_retryable';
  else if (/(runner image|disk full|out of memory|environment|toolchain|node version|platform)/.test(text)) classification = 'environment';
  else if (/(assert|test failed|syntaxerror|typeerror|referenceerror|compile|lint|diff --check)/.test(text)) classification = 'code_local';
  return {
    schema: 'sideways-maker-delivery-failure/v1',
    check_id: check.id || null,
    check_name: check.name || null,
    classification: FAILURE_CLASSES.has(classification) ? classification : 'unknown',
    summary: clean(log || JSON.stringify(check.evidence || {}) || check.name || 'Unknown failure', 1000),
  };
}

export function normalizeReviewItem(input = {}) {
  const kind = clean(input.kind || input.type || (input.path ? 'inline_thread' : 'issue_comment'), 100);
  const record = {
    schema: 'sideways-maker-delivery-review/v1',
    source_id: clean(input.id || input.node_id || input.url || deliveryDigest(input), 300),
    kind,
    author: clean(input.author || input.user?.login || 'unknown', 200),
    body: clean(input.body || input.review || input.comment || '', 10000),
    path: input.path ? clean(input.path, 1000) : null,
    line: Number.isInteger(input.line) ? input.line : null,
    state: clean(input.state || input.review_state || 'commented', 100).toLowerCase(),
    resolved: Boolean(input.resolved),
    command: input.command ? clean(input.command, 500) : null,
    url: clean(input.url || input.html_url || '', 2000),
  };
  record.actionable = !record.resolved && (
    record.state === 'changes_requested' ||
    ['inline_thread','requested_changes','human_command'].includes(record.kind) ||
    /\b(fix|change|repair|please|must|block|rerun|rollback|cancel|resume)\b/i.test(record.body)
  );
  record.digest = deliveryDigest(record);
  return record;
}

const defaultStore = () => {
  let snapshot = null;
  return {
    async load() { return snapshot ? structuredClone(snapshot) : null; },
    async save(value) { snapshot = structuredClone(value); }
  };
};

export function createDeliveryLoop(options = {}) {
  const clock = options.clock || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const github = options.github || {};
  const store = options.store || defaultStore();
  const maxLogBytes = Math.max(1024, options.maxLogBytes || 128 * 1024);
  const requiredChecks = [...new Set(options.requiredChecks || [])].sort();
  let state = {
    schema: 'sideways-maker-delivery-state/v1',
    repository: clean(options.repository || '', 300),
    branch: clean(options.branch || '', 300),
    pr_number: options.prNumber ?? null,
    head_sha: clean(options.headSha || '', 64),
    revision: 0,
    cursor: null,
    checks: [],
    failures: [],
    repair_attempts: [],
    reviews: [],
    release: null,
    deployments: [],
    cancelled: false,
    paused: false,
    events: [],
  };

  const emit = (type, detail = {}) => {
    const event = {
      schema: 'sideways-maker-delivery-event/v1',
      sequence: state.events.length + 1,
      type,
      at: nowIso(clock),
      detail: redactDeliverySecrets(detail),
    };
    event.event_id = `delivery-${event.sequence}-${deliveryDigest(event).slice(0, 12)}`;
    state.events.push(event);
    state.revision += 1;
    return event;
  };

  const persist = async () => store.save(state);

  async function hydrate() {
    const loaded = await store.load();
    if (loaded) state = structuredClone(loaded);
    return snapshot();
  }

  function snapshot() {
    const publicState = redactDeliverySecrets(structuredClone(state));
    publicState.state_digest = deliveryDigest({ ...publicState, state_digest: undefined });
    return publicState;
  }

  async function setHead(headSha, reason = 'head updated') {
    const next = clean(headSha, 64);
    if (!/^[a-f0-9]{7,64}$/i.test(next)) throw Object.assign(new Error('invalid head SHA'), { code: 'head_invalid' });
    if (state.head_sha && state.head_sha !== next) {
      state.checks = [];
      emit('head.changed', { from: state.head_sha, to: next, reason });
    }
    state.head_sha = next;
    await persist();
    return snapshot();
  }

  async function observeChecks(rawChecks = [], meta = {}) {
    const observedHead = clean(meta.head_sha || state.head_sha, 64);
    const checks = rawChecks.map(item => normalizeCheck(item, observedHead));
    state.checks = checks;
    state.cursor = meta.cursor ?? state.cursor;
    emit('checks.observed', { head_sha: observedHead, count: checks.length, cursor: state.cursor });
    const failures = [];
    for (const check of checks.filter(item => item.state === 'failure')) {
      let log = '';
      if (github.getJobLog) {
        try {
          log = clean(await github.getJobLog(check), maxLogBytes);
        } catch (error) {
          log = `log unavailable: ${clean(error?.message || error, 500)}`;
        }
      }
      const failure = classifyFailure(check, log);
      failure.log = redactDeliverySecrets(log);
      failure.digest = deliveryDigest(failure);
      failures.push(failure);
    }
    state.failures = failures;
    await persist();
    return { checks: structuredClone(checks), failures: structuredClone(failures) };
  }

  async function poll(options = {}) {
    const maxAttempts = Math.max(1, Math.min(50, options.maxAttempts || 8));
    const backoff = options.backoffMs || [0, 100, 250, 500, 1000, 2000];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (state.cancelled) throw Object.assign(new Error('delivery loop cancelled'), { code: 'cancelled' });
      if (state.paused) return { state: 'paused', snapshot: snapshot() };
      try {
        const response = await github.listChecks({
          repository: state.repository,
          head_sha: state.head_sha,
          cursor: state.cursor,
          signal: options.signal,
        });
        await observeChecks(response.checks || response.items || [], { head_sha: response.head_sha || state.head_sha, cursor: response.cursor });
        const pending = state.checks.some(check => ['queued','running','unknown'].includes(check.state));
        if (!pending) return { state: state.failures.length ? 'failure' : 'success', snapshot: snapshot() };
      } catch (error) {
        const rateLimited = error?.status === 429 || error?.code === 'rate_limited';
        emit(rateLimited ? 'poll.rate_limited' : 'poll.failed', { attempt: attempt + 1, error: clean(error?.message || error, 500) });
        if (!rateLimited && attempt === maxAttempts - 1) throw error;
      }
      await persist();
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? backoff.at(-1) ?? 0;
      if (delay > 0) await sleep(delay);
    }
    return { state: 'pending', snapshot: snapshot() };
  }

  async function createRepairAssignment(options = {}) {
    if (!state.failures.length) throw Object.assign(new Error('no failures to repair'), { code: 'no_failure' });
    const attempt = {
      schema: 'sideways-maker-repair-assignment/v1',
      attempt: state.repair_attempts.length + 1,
      source_head_sha: state.head_sha,
      failing_checks: state.failures.map(f => ({
        check_id: f.check_id,
        check_name: f.check_name,
        classification: f.classification,
        summary: f.summary,
      })),
      files: [...new Set(options.files || [])].sort(),
      tests: [...new Set(options.tests || state.failures.map(f => f.check_name).filter(Boolean))].sort(),
      created_at: nowIso(clock),
      status: 'assigned',
      previous_attempt_digests: state.repair_attempts.map(item => item.digest),
    };
    attempt.digest = deliveryDigest(attempt);
    state.repair_attempts.push(attempt);
    emit('repair.assigned', { attempt: attempt.attempt, digest: attempt.digest });
    await persist();
    return structuredClone(attempt);
  }

  async function recordRepairResult(result = {}) {
    const attempt = state.repair_attempts.at(-1);
    if (!attempt) throw Object.assign(new Error('no repair assignment'), { code: 'repair_missing' });
    attempt.status = result.ok ? 'completed' : 'failed';
    attempt.completed_at = nowIso(clock);
    attempt.result = redactDeliverySecrets(result);
    attempt.digest = deliveryDigest({ ...attempt, digest: undefined });
    emit('repair.recorded', { attempt: attempt.attempt, ok: Boolean(result.ok), new_head_sha: result.new_head_sha || null });
    if (result.new_head_sha) await setHead(result.new_head_sha, `repair attempt ${attempt.attempt}`);
    else await persist();
    return structuredClone(attempt);
  }

  async function ingestReviews(items = []) {
    const byId = new Map(state.reviews.map(item => [item.source_id, item]));
    for (const item of items.map(normalizeReviewItem)) byId.set(item.source_id, item);
    state.reviews = [...byId.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
    emit('reviews.ingested', {
      count: state.reviews.length,
      actionable: state.reviews.filter(item => item.actionable).length,
      unresolved: state.reviews.filter(item => !item.resolved).length,
    });
    await persist();
    return structuredClone(state.reviews);
  }

  function readiness() {
    const stale = state.checks.filter(check => check.head_sha && check.head_sha !== state.head_sha);
    const byName = new Map(state.checks.map(check => [check.name, check]));
    const missing = requiredChecks.filter(name => !byName.has(name));
    const failing = state.checks.filter(check => check.state === 'failure');
    const pending = state.checks.filter(check => ['queued','running','unknown'].includes(check.state));
    const unresolved = state.reviews.filter(item => item.actionable && !item.resolved);
    const ready = !state.cancelled && !state.paused && !stale.length && !missing.length && !failing.length && !pending.length && !unresolved.length;
    return { ready, stale, missing, failing, pending, unresolved, head_sha: state.head_sha };
  }

  async function createRelease(options = {}) {
    const gate = readiness();
    if (!gate.ready) throw Object.assign(new Error('release gate not satisfied'), { code: 'release_blocked', detail: gate });
    const release = {
      schema: 'sideways-maker-release-receipt/v1',
      repository: state.repository,
      branch: state.branch,
      pr_number: state.pr_number,
      head_sha: state.head_sha,
      version: clean(options.version || 'unversioned', 100),
      notes: clean(options.notes || '', 20000),
      changelog: [...new Set(options.changelog || [])],
      migrations: options.migrations || [],
      rollback: options.rollback || { available: true, instructions: 'Revert exact release commit.' },
      checks: state.checks.map(check => ({ id: check.id, name: check.name, state: check.state, head_sha: check.head_sha, digest: check.digest })),
      created_at: nowIso(clock),
    };
    release.digest = deliveryDigest(release);
    state.release = release;
    emit('release.prepared', { version: release.version, digest: release.digest });
    await persist();
    return structuredClone(release);
  }

  async function requestDeployment(options = {}) {
    const environment = clean(options.environment || 'preview', 100);
    if (!['dry-run','preview','canary','production'].includes(environment)) {
      throw Object.assign(new Error('unsupported environment'), { code: 'environment_invalid' });
    }
    if (!state.release) throw Object.assign(new Error('release receipt required'), { code: 'release_required' });
    const packet = options.authority || {};
    const admitted = environment === 'dry-run' || (
      packet.schema === 'sideways-maker-deployment-authority/v1' &&
      packet.environment === environment &&
      packet.head_sha === state.head_sha &&
      packet.allowed === true &&
      Date.parse(packet.expires_at || 0) > clock()
    );
    const request = {
      schema: 'sideways-maker-deployment-request/v1',
      environment,
      head_sha: state.head_sha,
      release_digest: state.release.digest,
      state: admitted ? 'authorized_request' : 'human_approval_required',
      authority_digest: admitted ? deliveryDigest(packet) : null,
      requested_at: nowIso(clock),
      adapter: clean(options.adapter || 'unconfigured', 200),
    };
    request.digest = deliveryDigest(request);
    state.deployments.push(request);
    emit('deployment.requested', { environment, state: request.state, digest: request.digest });
    await persist();
    return structuredClone(request);
  }

  async function verifySentinel(options = {}) {
    const deployment = state.deployments.at(-1);
    if (!deployment) throw Object.assign(new Error('deployment request missing'), { code: 'deployment_missing' });
    const observed = clean(options.observed_head_sha || '', 64);
    const expected = deployment.head_sha;
    const result = {
      schema: 'sideways-maker-deployment-verification/v1',
      environment: deployment.environment,
      expected_head_sha: expected,
      observed_head_sha: observed,
      sentinel: clean(options.sentinel || '', 500),
      ok: observed === expected && options.ok !== false,
      observed_at: nowIso(clock),
    };
    result.digest = deliveryDigest(result);
    deployment.verification = result;
    deployment.state = result.ok ? 'verified' : 'sentinel_mismatch';
    deployment.digest = deliveryDigest({ ...deployment, digest: undefined });
    emit(result.ok ? 'deployment.verified' : 'deployment.mismatch', result);
    await persist();
    return structuredClone(result);
  }

  async function requestRollback(reason = 'operator request') {
    const deployment = state.deployments.at(-1);
    const packet = {
      schema: 'sideways-maker-rollback-request/v1',
      environment: deployment?.environment || null,
      failed_deployment_digest: deployment?.digest || null,
      target_head_sha: state.release?.rollback?.target_head_sha || null,
      reason: clean(reason, 1000),
      state: 'human_approval_required',
      requested_at: nowIso(clock),
    };
    packet.digest = deliveryDigest(packet);
    emit('rollback.requested', packet);
    await persist();
    return packet;
  }

  async function pause(reason = 'operator pause') {
    state.paused = true;
    emit('delivery.paused', { reason: clean(reason, 500) });
    await persist();
  }

  async function resume(reason = 'operator resume') {
    state.paused = false;
    emit('delivery.resumed', { reason: clean(reason, 500) });
    await persist();
  }

  async function cancel(reason = 'operator cancel') {
    state.cancelled = true;
    emit('delivery.cancelled', { reason: clean(reason, 500) });
    await persist();
  }

  function receipt() {
    const body = {
      schema: 'sideways-maker-delivery-receipt/v1',
      repository: state.repository,
      branch: state.branch,
      pr_number: state.pr_number,
      head_sha: state.head_sha,
      cursor: state.cursor,
      checks: state.checks,
      failures: state.failures,
      repair_attempts: state.repair_attempts,
      reviews: state.reviews,
      release: state.release,
      deployments: state.deployments,
      events: state.events,
      readiness: readiness(),
      revision: state.revision,
    };
    return { ...redactDeliverySecrets(body), receipt_digest: deliveryDigest(redactDeliverySecrets(body)) };
  }

  return {
    hydrate, snapshot, setHead, observeChecks, poll, createRepairAssignment, recordRepairResult,
    ingestReviews, readiness, createRelease, requestDeployment, verifySentinel, requestRollback,
    pause, resume, cancel, receipt
  };
}
