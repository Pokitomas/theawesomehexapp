import { digest, stableJSONStringify } from './maker-executive-state.mjs';

export const EXECUTIVE_LEASE_REGISTRY_SCHEMA = 'sideways-maker-executive-lease-registry/v1';
export const EXECUTIVE_ASSIGNMENT_SCHEMA = 'sideways-maker-executive-assignment/v1';
export const EXECUTIVE_SUBTASK_SCHEMA = 'sideways-maker-executive-subtask/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const PATH_KINDS = new Set(['repository', 'generated']);
const SCOPE_KINDS = new Set([...PATH_KINDS, 'artifact', 'dataset', 'checkpoint', 'deployment']);
const LEASE_STATES = new Set(['active', 'delegated', 'released', 'revoked', 'superseded']);
const MUTABLE_STATES = new Set(['active', 'delegated']);
const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

function exact(value, pattern, label) {
  const normalized = clean(value, 1000).toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} must be an exact ${pattern === SHA40 ? '40-character commit SHA' : 'SHA-256 digest'}.`);
  return normalized;
}

function instant(value, label) {
  const timestamp = Date.parse(clean(value, 100));
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function repository(value) {
  const normalized = clean(value, 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('repository must be owner/name.');
  return normalized;
}

function canonicalPath(value) {
  let raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (['*', '**', '**/*'].includes(raw)) return '**';
  const directory = raw.endsWith('/**');
  if (directory) raw = raw.slice(0, -3).replace(/\/$/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || parts.some(part => ['.', '..'].includes(part)) || parts.join('/').includes('*')) throw new Error(`Invalid canonical path: ${raw}.`);
  return directory ? `${parts.join('/')}/**` : parts.join('/');
}

export function normalizeExecutiveScope(input = {}) {
  const kind = clean(input.kind, 100);
  if (!SCOPE_KINDS.has(kind)) throw new Error(`Unsupported executive scope kind: ${kind}.`);
  const id = PATH_KINDS.has(kind) ? canonicalPath(input.id ?? input.path) : clean(input.id, 1000);
  if (!id) throw new Error('Executive scope requires id.');
  return Object.freeze(canonical({ kind, id }));
}

export function executiveScopesOverlap(leftInput, rightInput) {
  const left = normalizeExecutiveScope(leftInput);
  const right = normalizeExecutiveScope(rightInput);
  if (PATH_KINDS.has(left.kind) && PATH_KINDS.has(right.kind)) {
    const a = left.id;
    const b = right.id;
    if (a === '**' || b === '**') return true;
    const ap = a.endsWith('/**') ? a.slice(0, -3) : a;
    const bp = b.endsWith('/**') ? b.slice(0, -3) : b;
    return ap === bp || (a.endsWith('/**') && bp.startsWith(`${ap}/`)) || (b.endsWith('/**') && ap.startsWith(`${bp}/`));
  }
  return left.kind === right.kind && left.id === right.id;
}

function scopeCovers(parentInput, childInput) {
  const parent = normalizeExecutiveScope(parentInput);
  const child = normalizeExecutiveScope(childInput);
  if (PATH_KINDS.has(parent.kind) && PATH_KINDS.has(child.kind)) {
    if (parent.id === '**') return true;
    const pp = parent.id.endsWith('/**') ? parent.id.slice(0, -3) : parent.id;
    const cp = child.id.endsWith('/**') ? child.id.slice(0, -3) : child.id;
    if (parent.id.endsWith('/**')) return cp === pp || cp.startsWith(`${pp}/`);
    return parent.id === child.id;
  }
  return parent.kind === child.kind && parent.id === child.id;
}

function normalizeScopes(values, label) {
  if (!Array.isArray(values) || !values.length) throw new Error(`${label} requires at least one scope.`);
  const normalized = values.map(normalizeExecutiveScope).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (normalized.some((value, index) => index > 0 && stableJSONStringify(value) === stableJSONStringify(normalized[index - 1]))) throw new Error(`${label} contains duplicate scopes.`);
  return normalized;
}

function normalizeLease(input = {}, index = 0, mainSha = '') {
  const id = clean(input.id, 200);
  const lane_id = clean(input.lane_id, 200);
  const holder_id = clean(input.holder_id, 200);
  const status = clean(input.status || 'active', 40);
  if (!id || !lane_id || !holder_id || !LEASE_STATES.has(status)) throw new Error(`Lease ${index} is incomplete.`);
  const source_sha = exact(input.source_sha || mainSha, SHA40, `${id}.source_sha`);
  const acquired_at = instant(input.acquired_at, `${id}.acquired_at`);
  const expires_at = instant(input.expires_at, `${id}.expires_at`);
  if (Date.parse(expires_at) <= Date.parse(acquired_at)) throw new Error(`Lease ${id} must expire after acquisition.`);
  if (Number(input.writer_count ?? 1) !== 1) throw new Error(`Lease ${id} must authorize exactly one writer.`);
  return canonical({
    id, lane_id, holder_id, source_sha, status,
    scopes: normalizeScopes(input.scopes, `Lease ${id}`),
    parent_lease_id: input.parent_lease_id ? clean(input.parent_lease_id, 200) : null,
    acquired_at, expires_at, writer_count: 1,
    reason: input.reason ? clean(input.reason, 2000) : null
  });
}

function activeCollision(leases) {
  for (let left = 0; left < leases.length; left += 1) {
    if (!MUTABLE_STATES.has(leases[left].status)) continue;
    for (let right = left + 1; right < leases.length; right += 1) {
      if (!MUTABLE_STATES.has(leases[right].status)) continue;
      const related = leases[left].id === leases[right].parent_lease_id || leases[right].id === leases[left].parent_lease_id;
      if (related && [leases[left].status, leases[right].status].includes('delegated')) continue;
      if (leases[left].scopes.some(a => leases[right].scopes.some(b => executiveScopesOverlap(a, b)))) {
        throw new Error(`Executive lease collision: ${leases[left].id} overlaps ${leases[right].id}.`);
      }
    }
  }
}

export function normalizeExecutiveLeaseRegistry(input = {}) {
  const main_sha = exact(input.main_sha, SHA40, 'main_sha');
  const body = canonical({
    schema: EXECUTIVE_LEASE_REGISTRY_SCHEMA,
    repository: repository(input.repository),
    generation_id: clean(input.generation_id, 200),
    main_sha,
    leases: (input.leases || []).map((lease, index) => normalizeLease(lease, index, main_sha)).sort((a, b) => a.id.localeCompare(b.id))
  });
  if (!body.generation_id) throw new Error('Lease registry requires generation_id.');
  if (new Set(body.leases.map(value => value.id)).size !== body.leases.length) throw new Error('Lease IDs must be unique.');
  for (const lease of body.leases) {
    if (lease.source_sha !== main_sha) throw new Error(`Lease ${lease.id} is stale.`);
    if (lease.parent_lease_id) {
      const parent = body.leases.find(value => value.id === lease.parent_lease_id);
      if (!parent) throw new Error(`Lease ${lease.id} has a missing parent.`);
      if (!lease.scopes.every(scope => parent.scopes.some(parentScope => scopeCovers(parentScope, scope)))) throw new Error(`Lease ${lease.id} exceeds parent ownership.`);
      if (lease.status === 'active' && parent.status !== 'delegated') throw new Error(`Active child ${lease.id} requires a delegated parent.`);
    }
    if (lease.status === 'delegated' && !body.leases.some(value => value.parent_lease_id === lease.id && value.status === 'active')) throw new Error(`Delegated lease ${lease.id} has no active child.`);
  }
  activeCollision(body.leases);
  return Object.freeze({ ...body, registry_digest: digest(body) });
}

function assertRegistryCAS(registryInput, expectedDigest) {
  const registry = normalizeExecutiveLeaseRegistry(registryInput);
  if (registry.registry_digest !== exact(expectedDigest, SHA256, 'expected_registry_digest')) throw new Error('Lease registry compare-and-swap failed.');
  return registry;
}

function withLeases(registry, leases) {
  return normalizeExecutiveLeaseRegistry({ ...registry, leases, registry_digest: undefined });
}

export function acquireExecutiveLease({ registry, expected_registry_digest, request, now = new Date().toISOString(), ttl_ms = 900000 } = {}) {
  const current = assertRegistryCAS(registry, expected_registry_digest);
  const acquired = instant(now, 'now');
  const ttl = Number(ttl_ms);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('ttl_ms must be positive.');
  const candidate = normalizeLease({
    ...request,
    source_sha: request?.source_sha || current.main_sha,
    acquired_at: acquired,
    expires_at: new Date(Date.parse(acquired) + ttl).toISOString(),
    status: 'active', writer_count: 1, parent_lease_id: null
  }, current.leases.length, current.main_sha);
  if (candidate.source_sha !== current.main_sha) throw new Error('Lease request is bound to a stale head.');
  if (current.leases.some(value => MUTABLE_STATES.has(value.status) && value.scopes.some(a => candidate.scopes.some(b => executiveScopesOverlap(a, b))))) throw new Error('Lease acquisition denied by overlapping ownership.');
  return withLeases(current, [...current.leases, candidate]);
}

export function inheritExecutiveLease({ registry, expected_registry_digest, parent_lease_id, child, now = new Date().toISOString(), ttl_ms = 600000 } = {}) {
  const current = assertRegistryCAS(registry, expected_registry_digest);
  const parent = current.leases.find(value => value.id === parent_lease_id);
  if (!parent || parent.status !== 'active') throw new Error('Lease inheritance requires an active parent.');
  const scopes = normalizeScopes(child?.scopes, 'Child lease');
  if (!scopes.every(scope => parent.scopes.some(parentScope => scopeCovers(parentScope, scope)))) throw new Error('Child lease exceeds parent ownership.');
  const acquired = instant(now, 'now');
  const ttl = Number(ttl_ms);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('ttl_ms must be positive.');
  const childLease = normalizeLease({
    ...child, scopes, source_sha: current.main_sha, parent_lease_id: parent.id,
    acquired_at: acquired,
    expires_at: new Date(Math.min(Date.parse(parent.expires_at), Date.parse(acquired) + ttl)).toISOString(),
    status: 'active', writer_count: 1
  }, current.leases.length, current.main_sha);
  const leases = current.leases.map(value => value.id === parent.id ? { ...value, status: 'delegated', reason: `delegated-to:${childLease.id}` } : value);
  return withLeases(current, [...leases, childLease]);
}

function descendants(leases, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const lease of leases) if (lease.parent_lease_id && ids.has(lease.parent_lease_id) && !ids.has(lease.id)) { ids.add(lease.id); changed = true; }
  }
  ids.delete(rootId);
  return ids;
}

export function transitionExecutiveLease({ registry, expected_registry_digest, lease_id, action, reason = '', now = new Date().toISOString() } = {}) {
  const current = assertRegistryCAS(registry, expected_registry_digest);
  const target = current.leases.find(value => value.id === lease_id);
  if (!target || !MUTABLE_STATES.has(target.status)) throw new Error('Lease transition requires mutable ownership.');
  const nextStatus = { release: 'released', revoke: 'revoked', supersede: 'superseded' }[action];
  if (!nextStatus) throw new Error(`Unsupported lease transition: ${action}.`);
  if (action === 'release' && target.status === 'delegated') throw new Error('Delegated parent cannot release while a child is active.');
  const at = instant(now, 'now');
  const cascade = action === 'release' ? new Set() : descendants(current.leases, target.id);
  let leases = current.leases.map(value => {
    if (value.id === target.id) return { ...value, status: nextStatus, reason: clean(reason || action, 2000), transitioned_at: at };
    if (cascade.has(value.id) && MUTABLE_STATES.has(value.status)) return { ...value, status: 'revoked', reason: `ancestor-${action}:${target.id}`, transitioned_at: at };
    return value;
  });
  if (target.parent_lease_id) {
    const siblings = leases.filter(value => value.parent_lease_id === target.parent_lease_id && value.id !== target.id && value.status === 'active');
    if (!siblings.length) leases = leases.map(value => value.id === target.parent_lease_id && value.status === 'delegated' ? { ...value, status: 'active', reason: `child-${action}:${target.id}` } : value);
  }
  return withLeases(current, leases);
}

export function expireExecutiveLeases(registryInput, { expected_registry_digest, now = new Date().toISOString() } = {}) {
  const current = assertRegistryCAS(registryInput, expected_registry_digest);
  const at = instant(now, 'now');
  const expiredRoots = current.leases.filter(value => MUTABLE_STATES.has(value.status) && Date.parse(value.expires_at) <= Date.parse(at)).map(value => value.id);
  if (!expiredRoots.length) return current;
  const revoked = new Set(expiredRoots);
  for (const root of expiredRoots) for (const child of descendants(current.leases, root)) revoked.add(child);
  let leases = current.leases.map(value => revoked.has(value.id) && MUTABLE_STATES.has(value.status) ? { ...value, status: 'revoked', reason: 'lease-expired', transitioned_at: at } : value);
  leases = leases.map(value => {
    if (value.status !== 'delegated' || Date.parse(value.expires_at) <= Date.parse(at)) return value;
    const activeChildren = leases.some(child => child.parent_lease_id === value.id && child.status === 'active');
    return activeChildren ? value : { ...value, status: 'active', reason: 'child-expired' };
  });
  return withLeases(current, leases);
}

function ancestors(leases, lease) {
  const ids = new Set();
  let current = lease;
  while (current?.parent_lease_id) {
    ids.add(current.parent_lease_id);
    current = leases.find(value => value.id === current.parent_lease_id);
  }
  return ids;
}

export function assertMutationOwned({ registry, lease_id, source_sha, changed_scopes = [] } = {}) {
  const current = normalizeExecutiveLeaseRegistry(registry);
  const lease = current.leases.find(value => value.id === lease_id);
  if (!lease || lease.status !== 'active') throw new Error('Mutation requires an active writer lease.');
  if (exact(source_sha, SHA40, 'source_sha') !== current.main_sha || lease.source_sha !== current.main_sha) throw new Error('Mutation denied against a stale head.');
  const changed = normalizeScopes(changed_scopes, 'Mutation');
  if (!changed.every(scope => lease.scopes.some(owned => scopeCovers(owned, scope)))) throw new Error('Mutation includes scope outside the granted lease.');
  const lineage = ancestors(current.leases, lease);
  for (const other of current.leases) {
    if (other.id === lease.id || lineage.has(other.id) || !MUTABLE_STATES.has(other.status)) continue;
    if (other.scopes.some(a => changed.some(b => executiveScopesOverlap(a, b)))) throw new Error('Mutation ownership is ambiguous.');
  }
  return Object.freeze({ lease_id: lease.id, holder_id: lease.holder_id, source_sha: current.main_sha, changed_scopes: changed });
}

export function verifyCommitPaths({ registry, lease_id, source_sha, changed_paths = [], generated_paths = [] } = {}) {
  const changed = changed_paths.map(path => ({ kind: 'repository', id: path }));
  const generated = generated_paths.map(path => ({ kind: 'generated', id: path }));
  return assertMutationOwned({ registry, lease_id, source_sha, changed_scopes: [...changed, ...generated] });
}

export function detectIntegrationScopeCollisions(outputs = []) {
  const normalized = outputs.map((value, index) => ({
    lane_id: clean(value.lane_id || `lane-${index + 1}`, 200),
    scopes: normalizeScopes(value.scopes, `Output ${index}`)
  }));
  const collisions = [];
  for (let left = 0; left < normalized.length; left += 1) for (let right = left + 1; right < normalized.length; right += 1) {
    for (const a of normalized[left].scopes) for (const b of normalized[right].scopes) if (executiveScopesOverlap(a, b)) collisions.push(canonical({ left_lane_id: normalized[left].lane_id, right_lane_id: normalized[right].lane_id, left_scope: a, right_scope: b }));
  }
  return Object.freeze(collisions);
}

function normalizePrincipal(input = {}, index = 0) {
  const id = clean(input.id, 200);
  if (!id) throw new Error(`Principal ${index} requires id.`);
  return canonical({
    id,
    read_sources: [...new Set((input.read_sources || []).map(value => clean(value, 100)))].sort(),
    write_authority: input.write_authority === true,
    environments: [...new Set((input.environments || []).map(value => clean(value, 100)))].sort(),
    hardware: [...new Set((input.hardware || []).map(value => clean(value, 100)))].sort(),
    owned_scopes: (input.owned_scopes || []).map(normalizeExecutiveScope),
    available: input.available !== false,
    credentials: [...new Set((input.credentials || []).map(value => clean(value, 100)))].sort()
  });
}

function principalCanRun(principal, lane) {
  const missing = [];
  for (const source of lane.required_read_sources || []) if (!principal.read_sources.includes(source)) missing.push(`read:${source}`);
  if (lane.mode === 'writer' && !principal.write_authority) missing.push('write-authority');
  if (lane.environment && !principal.environments.includes(lane.environment)) missing.push(`environment:${lane.environment}`);
  if (lane.compute_class && !principal.hardware.includes(lane.compute_class)) missing.push(`hardware:${lane.compute_class}`);
  for (const credential of lane.required_credentials || []) if (!principal.credentials.includes(credential)) missing.push(`credential:${credential}`);
  for (const scope of lane.owned_scopes || []) if (!principal.owned_scopes.some(value => scopeCovers(value, scope))) missing.push(`scope:${scope.kind}:${scope.id}`);
  if (!principal.available) missing.push('unavailable');
  return missing;
}

export function assignExecutiveLane({ lane = {}, principals = [], exclude_principals = [] } = {}) {
  const normalizedLane = canonical({
    id: clean(lane.id, 200), mode: clean(lane.mode || 'scout', 40), source_sha: exact(lane.source_sha, SHA40, 'lane.source_sha'),
    required_read_sources: [...new Set((lane.required_read_sources || []).map(value => clean(value, 100)))].sort(),
    required_credentials: [...new Set((lane.required_credentials || []).map(value => clean(value, 100)))].sort(),
    environment: clean(lane.environment, 100), compute_class: clean(lane.compute_class, 100),
    owned_scopes: (lane.owned_scopes || []).map(normalizeExecutiveScope)
  });
  if (!normalizedLane.id || !['scout', 'writer', 'verifier'].includes(normalizedLane.mode)) throw new Error('Lane assignment requires id and valid mode.');
  const excluded = new Set(exclude_principals.map(value => clean(value, 200)));
  const candidates = principals.map(normalizePrincipal).filter(value => !excluded.has(value.id)).map(principal => ({ principal, missing: principalCanRun(principal, normalizedLane) }));
  const eligible = candidates.filter(value => !value.missing.length).map(value => value.principal).sort((a, b) => a.id.localeCompare(b.id));
  if (!eligible.length) return Object.freeze({ schema: EXECUTIVE_ASSIGNMENT_SCHEMA, lane_id: normalizedLane.id, status: 'blocked', denial_reasons: candidates.map(value => ({ principal_id: value.principal.id, missing: value.missing })) });
  return Object.freeze({ schema: EXECUTIVE_ASSIGNMENT_SCHEMA, lane_id: normalizedLane.id, status: 'assigned', principal_id: eligible[0].id, source_sha: normalizedLane.source_sha, mode: normalizedLane.mode, environment: normalizedLane.environment, compute_class: normalizedLane.compute_class });
}

export function reassignBlockedLane({ lane, principals, prior_assignment, unavailable = {} } = {}) {
  const excluded = [prior_assignment?.principal_id, ...(unavailable.principals || [])].filter(Boolean);
  const adjusted = principals.map(value => unavailable.hardware?.includes?.(lane.compute_class) ? { ...value, hardware: (value.hardware || []).filter(item => item !== lane.compute_class) } : value);
  return assignExecutiveLane({ lane, principals: adjusted, exclude_principals: excluded });
}

export function buildReadOnlyScoutFanout({ source_sha, snapshot_digest, sources = [], principals = [] } = {}) {
  const head = exact(source_sha, SHA40, 'source_sha');
  const snapshot = exact(snapshot_digest, SHA256, 'snapshot_digest');
  return sources.map((source, index) => {
    const sourceId = clean(source.id || source.kind || `source-${index + 1}`, 100);
    const assignment = assignExecutiveLane({ lane: { id: `scout:${sourceId}`, mode: 'scout', source_sha: head, required_read_sources: [sourceId] }, principals });
    return Object.freeze({ id: `scout:${sourceId}`, source: sourceId, source_sha: head, snapshot_digest: snapshot, allowed_mutations: [], required_evidence: ['source-envelope'], terminal_output: 'exact source envelope or unavailable external authority', assignment });
  });
}

function normalizeBudget(input = {}) {
  const body = { tokens: Number(input.tokens ?? 0), compute_ms: Number(input.compute_ms ?? 0), storage_bytes: Number(input.storage_bytes ?? 0), workflow_reruns: Number(input.workflow_reruns ?? 0) };
  if (Object.values(body).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Subtask budgets must be non-negative finite numbers.');
  return body;
}

export function buildExecutiveSubtaskContract(input = {}) {
  const body = canonical({
    schema: EXECUTIVE_SUBTASK_SCHEMA,
    id: clean(input.id, 200),
    lane_id: clean(input.lane_id, 200),
    source_sha: exact(input.source_sha, SHA40, 'source_sha'),
    snapshot_digest: exact(input.snapshot_digest, SHA256, 'snapshot_digest'),
    exact_inputs: (input.exact_inputs || []).map((value, index) => ({ id: clean(value.id || `input-${index + 1}`, 200), digest: exact(value.digest, SHA256, `input-${index}.digest`) })),
    allowed_mutations: (input.allowed_mutations || []).map(normalizeExecutiveScope),
    required_evidence: [...new Set((input.required_evidence || []).map(value => clean(value, 200)))].sort(),
    terminal_output: clean(input.terminal_output, 4000),
    budget: normalizeBudget(input.budget)
  });
  if (!body.id || !body.lane_id || !body.terminal_output || !body.required_evidence.length) throw new Error('Subtask contract is incomplete.');
  const contract_digest = digest(body);
  return Object.freeze({ ...body, contract_digest });
}
