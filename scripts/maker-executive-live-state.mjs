import {
  diffExecutiveSnapshots,
  digest,
  normalizeExecutiveSnapshot,
  stableJSONStringify
} from './maker-executive-state.mjs';

export const EXECUTIVE_SOURCE_SCHEMA = 'sideways-maker-executive-source/v1';
export const EXECUTIVE_SYNTHESIS_SCHEMA = 'sideways-maker-executive-synthesis/v1';
export const EXECUTIVE_RESCAN_SCHEMA = 'sideways-maker-executive-rescan/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const COLLECTIONS = Object.freeze([
  'pulls', 'leases', 'issues', 'reviews', 'checks', 'jobs', 'runners',
  'artifacts', 'datasets', 'checkpoints', 'receipts', 'deployments', 'promotion_states'
]);
const TERMINAL_BRANCH_STATES = new Set(['closed', 'merged', 'superseded', 'revoked', 'terminated']);
const INVESTIGATION_PRIORITY = Object.freeze({ running: 40, ready: 30, blocked: 20, pending: 10 });
const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

function exactSha(value, label) {
  const normalized = clean(value, 1000).toLowerCase();
  if (!SHA40.test(normalized)) throw new Error(`${label} must be an exact 40-character commit SHA.`);
  return normalized;
}

function instant(value, label) {
  const timestamp = Date.parse(clean(value, 100));
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function repositoryName(value) {
  const normalized = clean(value, 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('repository must be owner/name.');
  return normalized;
}

function recordId(value = {}) {
  return clean(value.id ?? value.number ?? value.name ?? value.sha ?? value.digest, 500);
}

function sourceRecords(source, name) {
  const values = source.records?.[name] ?? source[name] ?? [];
  if (!Array.isArray(values)) throw new Error(`${source.source_id}.${name} must be an array.`);
  return values;
}

function normalizeSource(source = {}, index, context) {
  const source_id = clean(source.source_id || `source-${index + 1}`, 200);
  const kind = clean(source.kind, 100);
  const repository = repositoryName(source.repository);
  const main_sha = exactSha(source.main_sha, `${source_id}.main_sha`);
  const observed_at = instant(source.observed_at, `${source_id}.observed_at`);
  if (!source_id || !kind) throw new Error(`Source ${index} requires source_id and kind.`);
  if (repository !== context.repository) throw new Error(`Source ${source_id} targets a different repository.`);
  if (main_sha !== context.main_sha) throw new Error(`Source ${source_id} is bound to a stale main SHA.`);
  const age = Date.parse(context.observed_at) - Date.parse(observed_at);
  if (age < 0) throw new Error(`Source ${source_id} is observed in the future.`);
  if (age > context.max_source_age_ms) throw new Error(`Source ${source_id} is stale by ${age}ms.`);
  const records = Object.fromEntries(COLLECTIONS.map(name => [name, sourceRecords(source, name)]));
  return canonical({ schema: EXECUTIVE_SOURCE_SCHEMA, source_id, kind, repository, main_sha, observed_at, authority: source.authority || {}, records });
}

function mergeAuthority(target, incoming, sourceId) {
  for (const [key, value] of Object.entries(incoming || {})) {
    if (Object.hasOwn(target, key) && stableJSONStringify(target[key]) !== stableJSONStringify(value)) {
      throw new Error(`Conflicting authority ${key} from ${sourceId}.`);
    }
    target[key] = value;
  }
}

function mergeRecord(map, value, collection, sourceId) {
  const id = recordId(value);
  if (!id) throw new Error(`${sourceId}.${collection} contains a record without id.`);
  const normalized = canonical({ ...value, id });
  const existing = map.get(id);
  if (existing && stableJSONStringify(existing.value) !== stableJSONStringify(normalized)) {
    throw new Error(`Conflicting live state for ${collection}:${id}.`);
  }
  if (existing) existing.sources.add(sourceId);
  else map.set(id, { value: normalized, sources: new Set([sourceId]) });
}

function normalizeLeasePath(value) {
  let raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (['*', '**', '**/*'].includes(raw)) return '**';
  const directory = raw.endsWith('/**');
  if (directory) raw = raw.slice(0, -3).replace(/\/$/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || parts.some(part => ['.', '..'].includes(part)) || parts.join('/').includes('*')) {
    throw new Error(`Invalid lease path: ${raw}.`);
  }
  return directory ? `${parts.join('/')}/**` : parts.join('/');
}

export function parseExecutiveLeaseMarker(body, pull = {}) {
  const match = /<!--\s*sideways-maker-lease:v1\s*\n([\s\S]*?)\n-->/m.exec(String(body || ''));
  if (!match) return null;
  let lease;
  try { lease = JSON.parse(match[1]); } catch (error) { throw new Error(`Invalid Maker lease JSON: ${error.message}`); }
  if (lease.schema !== 'sideways-maker-lease/v1') throw new Error('Unsupported Maker lease schema.');
  if (Number(lease.writer_count) !== 1) throw new Error('Maker lease must authorize exactly one writer.');
  const owned_paths = [...new Set((lease.owned_paths || []).map(normalizeLeasePath))].sort();
  if (!owned_paths.length) throw new Error('Maker lease requires owned paths.');
  const pullId = recordId(pull) || clean(lease.session_id || lease.branch, 200);
  if (!pullId) throw new Error('Maker lease requires a pull or session identity.');
  const state = clean(pull.state || 'open', 40).toLowerCase();
  return canonical({
    id: `lease:pr:${pullId}`,
    schema: lease.schema,
    session_id: clean(lease.session_id, 200),
    branch: clean(lease.branch, 300),
    base_branch: clean(lease.base_branch || 'main', 200),
    base_sha: exactSha(lease.base_sha, 'lease.base_sha'),
    head_sha: pull.head_sha ? exactSha(pull.head_sha, 'pull.head_sha') : undefined,
    owned_paths,
    writer_count: 1,
    authority: lease.authority || {},
    status: TERMINAL_BRANCH_STATES.has(state) ? 'completed' : 'active',
    source_pr: String(pullId)
  });
}

function addDefaultPromotionStates(collections) {
  const promotions = new Map(collections.promotion_states.map(value => [value.id, value]));
  for (const collection of ['artifacts', 'checkpoints']) {
    for (const value of collections[collection]) {
      if (!['model', 'adapter', 'checkpoint', 'gguf'].includes(clean(value.kind || value.type, 100).toLowerCase())) continue;
      const id = `promotion:${value.id}`;
      if (!promotions.has(id)) promotions.set(id, canonical({ id, subject_id: value.id, state: 'promotion:not-admitted' }));
    }
  }
  collections.promotion_states = [...promotions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function synthesizeExecutiveLiveState({ repository, main_sha, observed_at = new Date().toISOString(), max_source_age_ms = 300000, sources = [] } = {}) {
  const context = {
    repository: repositoryName(repository),
    main_sha: exactSha(main_sha, 'main_sha'),
    observed_at: instant(observed_at, 'observed_at'),
    max_source_age_ms: Number(max_source_age_ms)
  };
  if (!Number.isFinite(context.max_source_age_ms) || context.max_source_age_ms < 0) throw new Error('max_source_age_ms must be a non-negative number.');
  if (!Array.isArray(sources) || !sources.length) throw new Error('At least one live-state source is required.');
  const normalizedSources = sources.map((source, index) => normalizeSource(source, index, context));
  if (new Set(normalizedSources.map(value => value.source_id)).size !== normalizedSources.length) throw new Error('Live-state source IDs must be unique.');

  const authority = {};
  const maps = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()]));
  for (const source of normalizedSources) {
    mergeAuthority(authority, source.authority, source.source_id);
    for (const name of COLLECTIONS) for (const value of source.records[name]) mergeRecord(maps[name], value, name, source.source_id);
  }
  for (const pull of [...maps.pulls.values()].map(value => value.value)) {
    const lease = parseExecutiveLeaseMarker(pull.body, pull);
    if (lease) mergeRecord(maps.leases, lease, 'leases', `pull:${pull.id}`);
  }
  const collections = Object.fromEntries(COLLECTIONS.map(name => [name, [...maps[name].values()].map(value => value.value).sort((a, b) => a.id.localeCompare(b.id))]));
  addDefaultPromotionStates(collections);
  const snapshot = normalizeExecutiveSnapshot({ ...context, authority, ...collections });
  const source_manifest = normalizedSources.map(source => canonical({
    source_id: source.source_id,
    kind: source.kind,
    observed_at: source.observed_at,
    collection_counts: Object.fromEntries(COLLECTIONS.map(name => [name, source.records[name].length]))
  }));
  const receiptBody = canonical({
    schema: EXECUTIVE_SYNTHESIS_SCHEMA,
    repository: context.repository,
    main_sha: context.main_sha,
    observed_at: context.observed_at,
    snapshot_digest: snapshot.snapshot_digest,
    sources: source_manifest
  });
  return Object.freeze({ snapshot, synthesis_receipt: Object.freeze({ ...receiptBody, synthesis_digest: digest(receiptBody) }) });
}

function changedIdentities(delta, collection) {
  const value = delta.changed[collection];
  return value ? [...value.added, ...value.removed, ...value.updated].sort() : [];
}

export function buildEventTriggeredRescan({ previous_snapshot, current_snapshot, watchpoints = [] } = {}) {
  const delta = diffExecutiveSnapshots(previous_snapshot, current_snapshot);
  const previous = normalizeExecutiveSnapshot(previous_snapshot);
  const current = normalizeExecutiveSnapshot(current_snapshot);
  const triggered = [];
  for (const [index, input] of watchpoints.entries()) {
    const id = clean(input.id || `watchpoint-${index + 1}`, 200);
    const source_sha = exactSha(input.source_sha, `${id}.source_sha`);
    if (source_sha !== previous.main_sha) throw new Error(`Watchpoint ${id} is stale.`);
    const collections = [...new Set((input.collections || []).map(value => clean(value, 100)))].sort();
    if (collections.some(value => !COLLECTIONS.includes(value))) throw new Error(`Watchpoint ${id} names an unknown collection.`);
    const identityMap = input.identities || {};
    const changedCollections = collections.filter(name => delta.changed_collections.includes(name));
    const matchedIdentities = Object.fromEntries(changedCollections.map(name => {
      const changed = changedIdentities(delta, name);
      const expected = new Set((identityMap[name] || []).map(value => clean(value, 500)));
      return [name, expected.size ? changed.filter(value => expected.has(value)) : changed];
    }).filter(([, values]) => values.length));
    if (delta.main_sha_changed || Object.keys(matchedIdentities).length) {
      triggered.push(canonical({
        id,
        reason: delta.main_sha_changed ? 'repository-head-changed' : 'watched-state-changed',
        previous_main_sha: previous.main_sha,
        exact_head: current.main_sha,
        snapshot_digest: current.snapshot_digest,
        changed: matchedIdentities,
        mutation_surfaces: [...new Set((input.mutation_surfaces || []).map(normalizeLeasePath))].sort()
      }));
    }
  }
  const body = canonical({
    schema: EXECUTIVE_RESCAN_SCHEMA,
    repository: current.repository,
    exact_head: current.main_sha,
    previous_snapshot_digest: previous.snapshot_digest,
    current_snapshot_digest: current.snapshot_digest,
    delta_digest: delta.delta_digest,
    inspect_collections: delta.changed_collections,
    triggered_watchpoints: triggered,
    no_change: !delta.main_sha_changed && delta.changed_collections.length === 0
  });
  return Object.freeze({ ...body, rescan_digest: digest(body) });
}

function pathsOverlap(left, right) {
  const a = normalizeLeasePath(left);
  const b = normalizeLeasePath(right);
  if (a === '**' || b === '**') return true;
  const ap = a.endsWith('/**') ? a.slice(0, -3) : a;
  const bp = b.endsWith('/**') ? b.slice(0, -3) : b;
  return ap === bp || (a.endsWith('/**') && bp.startsWith(`${ap}/`)) || (b.endsWith('/**') && ap.startsWith(`${bp}/`));
}

export function selectCanonicalInvestigations(investigations = [], { main_sha } = {}) {
  const head = exactSha(main_sha, 'main_sha');
  const normalized = investigations.map((value, index) => {
    const id = clean(value.id || `investigation-${index + 1}`, 200);
    const hypothesis_key = clean(value.hypothesis_key, 500);
    const source_sha = exactSha(value.source_sha, `${id}.source_sha`);
    const owned_paths = [...new Set((value.owned_paths || []).map(normalizeLeasePath))].sort();
    if (!hypothesis_key || !owned_paths.length) throw new Error(`Investigation ${id} is incomplete.`);
    if (source_sha !== head) throw new Error(`Investigation ${id} is stale.`);
    return canonical({ ...value, id, hypothesis_key, source_sha, owned_paths, status: clean(value.status || 'pending', 40), evidence_count: Number(value.evidence_count || value.evidence?.length || 0), created_at: instant(value.created_at, `${id}.created_at`) });
  });
  const visited = new Set();
  const canonicalLanes = [];
  const terminated = [];
  const overlaps = (left, right) => left.hypothesis_key === right.hypothesis_key && left.owned_paths.some(a => right.owned_paths.some(b => pathsOverlap(a, b)));
  for (const investigation of normalized) {
    if (visited.has(investigation.id)) continue;
    const group = [];
    const queue = [investigation];
    visited.add(investigation.id);
    while (queue.length) {
      const current = queue.shift();
      group.push(current);
      for (const candidate of normalized) {
        if (visited.has(candidate.id) || !overlaps(current, candidate)) continue;
        visited.add(candidate.id);
        queue.push(candidate);
      }
    }
    group.sort((a, b) => (INVESTIGATION_PRIORITY[b.status] || 0) - (INVESTIGATION_PRIORITY[a.status] || 0) || b.evidence_count - a.evidence_count || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const selected = group[0];
    canonicalLanes.push(selected);
    for (const duplicate of group.slice(1)) terminated.push(canonical({ id: duplicate.id, status: 'terminated', reason: 'duplicate-investigation', canonical_lane_id: selected.id }));
  }
  return Object.freeze({ canonical: canonicalLanes.sort((a, b) => a.id.localeCompare(b.id)), terminated: terminated.sort((a, b) => a.id.localeCompare(b.id)) });
}

export function evictSupersededAttention(events = [], { current_main_sha, active_branches = [], disproven_hypotheses = [], now = new Date().toISOString() } = {}) {
  const head = exactSha(current_main_sha, 'current_main_sha');
  const active = new Set(active_branches.map(value => clean(value, 300)));
  const disproven = new Set(disproven_hypotheses.map(value => clean(value, 500)));
  const timestamp = Date.parse(instant(now, 'now'));
  const kept = [];
  const evicted = [];
  for (const [index, event] of events.entries()) {
    const normalized = canonical({ ...event, id: clean(event.id || `event-${index + 1}`, 200) });
    let reason = null;
    if (event.source_sha && exactSha(event.source_sha, `${normalized.id}.source_sha`) !== head) reason = 'stale-head';
    else if (event.branch && !active.has(clean(event.branch, 300))) reason = 'superseded-branch';
    else if (event.hypothesis_key && disproven.has(clean(event.hypothesis_key, 500))) reason = 'disproven-assumption';
    else if (event.expires_at && Date.parse(instant(event.expires_at, `${normalized.id}.expires_at`)) < timestamp) reason = 'stale-log';
    if (reason) evicted.push(canonical({ ...normalized, eviction_reason: reason }));
    else kept.push(normalized);
  }
  return Object.freeze({ kept, evicted });
}
