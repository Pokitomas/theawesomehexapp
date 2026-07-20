import crypto from 'node:crypto';

export const EXECUTIVE_SNAPSHOT_SCHEMA = 'sideways-maker-executive-snapshot/v1';
export const EXECUTIVE_PLAN_SCHEMA = 'sideways-maker-executive-plan/v1';
export const EXECUTIVE_MEMORY_SCHEMA = 'sideways-maker-executive-memory/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const COLLECTIONS = Object.freeze([
  'pulls', 'leases', 'issues', 'reviews', 'checks', 'jobs', 'runners',
  'artifacts', 'datasets', 'checkpoints', 'receipts', 'deployments', 'promotion_states'
]);
const TERMINAL = new Set(['completed', 'terminated', 'superseded', 'revoked']);
const STATES = new Set(['pending', 'ready', 'running', 'blocked', ...TERMINAL]);
const ATTENTION_WEIGHT = Object.freeze({ blocker: 100, regression: 90, failed_gate: 85, unverified_claim: 75, expiring_lease: 70 });

const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

export const stableJSONStringify = value => JSON.stringify(canonical(value));
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');

function exact(value, pattern, label) {
  const normalized = clean(value, 1000);
  if (!pattern.test(normalized)) throw new Error(pattern === SHA40 ? `${label} must be an exact 40-character commit SHA.` : `${label} must be an exact SHA-256 digest.`);
  return normalized.toLowerCase();
}

function instant(value, label) {
  const timestamp = Date.parse(clean(value, 80));
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function record(value = {}, index, name) {
  const id = clean(value.id ?? value.number ?? value.name ?? value.sha ?? value.digest, 500);
  if (!id) throw new Error(`${name}[${index}] requires id.`);
  const normalized = { ...value, id };
  for (const key of ['head_sha', 'base_sha', 'source_sha', 'result_sha', 'commit_sha']) {
    if (normalized[key]) normalized[key] = exact(normalized[key], SHA40, `${name}[${index}].${key}`);
  }
  for (const key of ['digest', 'sha256', 'artifact_digest', 'dataset_digest', 'checkpoint_digest', 'receipt_digest']) {
    if (normalized[key]) normalized[key] = exact(normalized[key], SHA256, `${name}[${index}].${key}`);
  }
  return canonical(normalized);
}

function collection(values, name) {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array.`);
  const normalized = values.map((value, index) => record(value, index, name)).sort((a, b) => a.id.localeCompare(b.id));
  if (normalized.some((value, index) => index > 0 && value.id === normalized[index - 1].id)) throw new Error(`${name} contains duplicate ids.`);
  return normalized;
}

export function normalizeExecutiveSnapshot(input = {}) {
  const body = {
    schema: EXECUTIVE_SNAPSHOT_SCHEMA,
    repository: clean(input.repository, 300),
    main_sha: exact(input.main_sha, SHA40, 'main_sha'),
    observed_at: instant(input.observed_at, 'observed_at'),
    authority: canonical(input.authority || {})
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repository)) throw new Error('repository must be owner/name.');
  for (const name of COLLECTIONS) body[name] = collection(input[name] || [], name);
  const normalized = canonical(body);
  return Object.freeze({ ...normalized, snapshot_digest: digest(normalized) });
}

export function assertFreshSnapshot(input, { expected_main_sha, now = new Date().toISOString(), max_age_ms = 300000 } = {}) {
  const snapshot = normalizeExecutiveSnapshot(input);
  if (expected_main_sha && snapshot.main_sha !== exact(expected_main_sha, SHA40, 'expected_main_sha')) throw new Error('Stale executive snapshot: main SHA changed.');
  const age = Date.parse(instant(now, 'now')) - Date.parse(snapshot.observed_at);
  if (age < 0) throw new Error('Executive snapshot is from the future.');
  if (!Number.isFinite(max_age_ms) || max_age_ms < 0 || age > max_age_ms) throw new Error(`Stale executive snapshot: age ${age}ms.`);
  return snapshot;
}

const byId = values => new Map(values.map(value => [value.id, value]));

export function diffExecutiveSnapshots(previousInput, currentInput) {
  const previous = normalizeExecutiveSnapshot(previousInput);
  const current = normalizeExecutiveSnapshot(currentInput);
  if (previous.repository !== current.repository) throw new Error('Cannot diff different repositories.');
  const changed = {};
  for (const name of COLLECTIONS) {
    const left = byId(previous[name]);
    const right = byId(current[name]);
    const added = [...right.keys()].filter(id => !left.has(id)).sort();
    const removed = [...left.keys()].filter(id => !right.has(id)).sort();
    const updated = [...right.keys()].filter(id => left.has(id) && stableJSONStringify(left.get(id)) !== stableJSONStringify(right.get(id))).sort();
    if (added.length || removed.length || updated.length) changed[name] = { added, removed, updated };
  }
  const body = canonical({
    schema: 'sideways-maker-executive-delta/v1', repository: current.repository,
    previous_snapshot_digest: previous.snapshot_digest, current_snapshot_digest: current.snapshot_digest,
    previous_main_sha: previous.main_sha, current_main_sha: current.main_sha,
    main_sha_changed: previous.main_sha !== current.main_sha, changed,
    changed_collections: Object.keys(changed).sort()
  });
  return Object.freeze({ ...body, delta_digest: digest(body) });
}

function leasePath(value) {
  let raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (['*', '**', '**/*'].includes(raw)) return '**';
  const directory = raw.endsWith('/**');
  if (directory) raw = raw.slice(0, -3).replace(/\/$/, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('Lease path must be repository-relative.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => ['.', '..'].includes(part)) || parts.join('/').includes('*')) throw new Error('Invalid lease path.');
  return directory ? `${parts.join('/')}/**` : parts.join('/');
}

export function pathsOverlap(left, right) {
  const a = leasePath(left);
  const b = leasePath(right);
  if (a === '**' || b === '**') return true;
  const ap = a.endsWith('/**') ? a.slice(0, -3) : a;
  const bp = b.endsWith('/**') ? b.slice(0, -3) : b;
  return ap === bp || (a.endsWith('/**') && bp.startsWith(`${ap}/`)) || (b.endsWith('/**') && ap.startsWith(`${bp}/`));
}

function lane(input = {}, index, sourceSha) {
  const id = clean(input.id, 200);
  const status = clean(input.status || 'pending', 40);
  const terminal_condition = clean(input.terminal_condition, 4000);
  const owned_paths = [...new Set((input.owned_paths || []).map(leasePath))].sort();
  if (!id || !STATES.has(status) || !terminal_condition || !owned_paths.length) throw new Error(`Lane ${index} is incomplete.`);
  return canonical({
    id, title: clean(input.title || id, 500), status, terminal_condition, owned_paths,
    source_sha: exact(input.source_sha || sourceSha, SHA40, `${id}.source_sha`),
    dependencies: [...new Set((input.dependencies || []).map(value => clean(value, 200)).filter(Boolean))].sort(),
    required_authority: [...new Set((input.required_authority || []).map(value => clean(value, 200)).filter(Boolean))].sort(),
    required_evidence: [...new Set((input.required_evidence || []).map(value => clean(value, 500)).filter(Boolean))].sort(),
    environment: clean(input.environment || 'any', 100), compute_class: clean(input.compute_class || 'cpu', 100),
    unblock_value: Number(input.unblock_value || 0), collision_risk: Number(input.collision_risk || 0),
    evidence_yield: Number(input.evidence_yield || 0), compute_cost: Number(input.compute_cost || 0)
  });
}

function orderLanes(lanes) {
  const index = new Map(lanes.map(value => [value.id, value]));
  const temporary = new Set();
  const permanent = new Set();
  const order = [];
  function visit(id) {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new Error(`Executive dependency cycle includes ${id}.`);
    const current = index.get(id);
    if (!current) throw new Error(`Missing dependency ${id}.`);
    temporary.add(id);
    for (const dependency of current.dependencies) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  }
  for (const current of lanes) visit(current.id);
  return order;
}

export function buildExecutivePlan({ snapshot, lanes = [], plan_id = '', created_at = new Date().toISOString() } = {}) {
  const resolved = normalizeExecutiveSnapshot(snapshot);
  const normalized = lanes.map((value, index) => lane(value, index, resolved.main_sha));
  if (new Set(normalized.map(value => value.id)).size !== normalized.length) throw new Error('Executive lane ids must be unique.');
  const body = canonical({
    schema: EXECUTIVE_PLAN_SCHEMA, plan_id: clean(plan_id || `plan-${resolved.main_sha.slice(0, 12)}`, 200),
    repository: resolved.repository, source_snapshot_digest: resolved.snapshot_digest, source_main_sha: resolved.main_sha,
    created_at: instant(created_at, 'created_at'), topological_order: orderLanes(normalized), lanes: normalized
  });
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

function collision(current, leases) {
  return leases.some(active => !TERMINAL.has(active.status) && (active.owned_paths || []).some(a => current.owned_paths.some(b => pathsOverlap(a, b))));
}

export function enumerateLegalTransitions({ plan, snapshot, active_leases = [], completed_evidence = {} } = {}) {
  const resolved = normalizeExecutiveSnapshot(snapshot);
  if (plan.schema !== EXECUTIVE_PLAN_SCHEMA || plan.source_snapshot_digest !== resolved.snapshot_digest || plan.source_main_sha !== resolved.main_sha) throw new Error('Executive plan is invalidated by repository state change.');
  const lanes = new Map(plan.lanes.map(value => [value.id, value]));
  return plan.topological_order.map(id => {
    const current = lanes.get(id);
    let reason = 'lane is terminal';
    let legal_action = 'none';
    if (!TERMINAL.has(current.status)) {
      if (!current.dependencies.every(dependency => lanes.get(dependency).status === 'completed')) reason = 'dependencies incomplete';
      else if (collision(current, active_leases)) reason = 'active lease collision';
      else if (!current.required_authority.every(key => ['granted', true].includes(resolved.authority[key]))) reason = 'required authority unavailable';
      else if (!current.required_evidence.every(key => completed_evidence[key] === true)) reason = 'required upstream evidence unavailable';
      else { reason = 'executable'; legal_action = current.status === 'running' ? 'continue' : 'start'; }
    }
    const score = current.unblock_value * 4 + current.evidence_yield * 2 - current.collision_risk * 3 - current.compute_cost;
    return Object.freeze({ lane_id: id, legal_action, reason, score });
  });
}

export function rankExecutableActions(input = {}) {
  return enumerateLegalTransitions(input).filter(value => value.legal_action !== 'none').sort((a, b) => b.score - a.score || a.lane_id.localeCompare(b.lane_id));
}

export function assertPlanValid({ plan, snapshot, active_leases = [], expected_authority = {} } = {}) {
  const resolved = normalizeExecutiveSnapshot(snapshot);
  if (plan.source_snapshot_digest !== resolved.snapshot_digest) throw new Error('Plan invalidated: snapshot digest changed.');
  if (plan.source_main_sha !== resolved.main_sha) throw new Error('Plan invalidated: main SHA changed.');
  for (const [key, value] of Object.entries(expected_authority)) if (resolved.authority[key] !== value) throw new Error(`Plan invalidated: authority ${key} changed.`);
  for (const current of plan.lanes) if (!TERMINAL.has(current.status) && collision(current, active_leases)) throw new Error(`Plan invalidated: lease collision for ${current.id}.`);
  return true;
}

export function normalizeLaneMemory(input = {}) {
  const body = canonical({
    schema: EXECUTIVE_MEMORY_SCHEMA, lane_id: clean(input.lane_id, 200),
    source_sha: exact(input.source_sha, SHA40, 'source_sha'),
    owned_paths: [...new Set((input.owned_paths || []).map(leasePath))].sort(),
    hypotheses: input.hypotheses || [], commands: input.commands || [], evidence: input.evidence || [], failures: input.failures || [],
    negative_results: input.negative_results || [], provenance: input.provenance || [], next_action: clean(input.next_action, 4000),
    checkpoint_digest: input.checkpoint_digest ? exact(input.checkpoint_digest, SHA256, 'checkpoint_digest') : null,
    expires_at: input.expires_at ? instant(input.expires_at, 'expires_at') : null
  });
  if (!body.lane_id || !body.owned_paths.length) throw new Error('Lane memory requires lane_id and owned_paths.');
  return Object.freeze({ ...body, memory_digest: digest(body) });
}

export function assertMemoryFresh(input, { main_sha, now = new Date().toISOString() } = {}) {
  const memory = normalizeLaneMemory(input);
  if (memory.source_sha !== exact(main_sha, SHA40, 'main_sha')) throw new Error('Lane memory expired because repository head changed.');
  if (memory.expires_at && Date.parse(instant(now, 'now')) > Date.parse(memory.expires_at)) throw new Error('Lane memory expired by time.');
  return memory;
}

export function buildAttentionQueue(events = [], now = new Date().toISOString()) {
  const timestamp = Date.parse(instant(now, 'now'));
  return events.map((event, index) => {
    const type = clean(event.type, 100);
    if (!Object.hasOwn(ATTENTION_WEIGHT, type)) throw new Error(`Unknown attention event type: ${type}.`);
    const expires = event.expires_at ? Date.parse(instant(event.expires_at, `events[${index}].expires_at`)) : null;
    const urgency = expires == null ? 0 : Math.min(20, Math.max(0, 20 - Math.floor((expires - timestamp) / 60000)));
    return canonical({ id: clean(event.id || `${type}-${index + 1}`, 200), type, summary: clean(event.summary, 2000), source: clean(event.source, 1000), priority: ATTENTION_WEIGHT[type] + urgency, expires_at: expires == null ? null : new Date(expires).toISOString() });
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function assertLaneCompletion({ lane, mutation_receipt, evidence = [], terminal_observed = false } = {}) {
  if (!lane?.terminal_condition) throw new Error('Lane terminal condition is required.');
  if (mutation_receipt?.status !== 'ready' || !mutation_receipt.receipt_digest) throw new Error('Lane completion requires a ready mutation receipt.');
  const types = new Set(evidence.map(value => clean(value.type, 200)));
  for (const required of lane.required_evidence || []) if (!types.has(required)) throw new Error(`Lane completion is missing evidence ${required}.`);
  if (terminal_observed !== true) throw new Error('Lane terminal condition is not independently observed.');
  return Object.freeze({ lane_id: lane.id, status: 'completed', receipt_digest: exact(mutation_receipt.receipt_digest, SHA256, 'receipt_digest') });
}
