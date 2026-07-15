import { createHash } from 'node:crypto';
import { COGNITION_KINDS, normalizeCognitionEvent } from './weave-cognition.mjs';

const FORBIDDEN_AUTHORITY = new Set(['merge', 'deploy', 'grant', 'admin', 'canonical_mutation', 'repo_write', 'repo:write']);
const FORBIDDEN_EVENT_KINDS = new Set(['decision', 'assignment', 'dispatch.started', 'dispatch.completed', 'wave.receipt', 'supersede']);
const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|secret|token|password|private[_-]?key|credential|authorization|cookie)($|[_-])/i;
const SECRET_VALUE_PATTERNS = [
  /(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[^\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/
];

export function dispatchIdempotencyKey({ wave_id, assignment_id, adapter_id }) {
  return createHash('sha256').update(`${wave_id}|${assignment_id}|${adapter_id}`).digest('hex');
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function buildRolePacket(assignmentEvent, memory, adapterId) {
  if (assignmentEvent?.kind !== 'assignment') throw new Error('Assignment event required.');
  const body = assignmentEvent.body;
  return deepFreeze({
    protocol: 'sideways-role-packet',
    version: 1,
    idempotency_key: dispatchIdempotencyKey({ wave_id: body.wave_id, assignment_id: body.assignment_id, adapter_id: adapterId }),
    adapter_id: adapterId,
    assignment: {
      event_id: assignmentEvent.id,
      id: body.assignment_id,
      wave_id: body.wave_id,
      role: body.role,
      target_ids: [...body.target_ids],
      expected_kinds: [...body.expected_kinds],
      completion_criteria: [...body.completion_criteria],
      budget: { ...body.budget },
      artifact_scope: [...body.artifact_scope]
    },
    memory: structuredClone(memory || { events: [] }),
    authority: {
      canonical_state: false,
      merge: false,
      deploy: false,
      grant: false,
      admin: false,
      repo_write: false
    }
  });
}

function rejectSecretMaterial(value, path = 'output', depth = 0) {
  if (depth > 16) throw new Error('Adapter output is too deeply nested.');
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) throw new Error(`Adapter output contains secret-like material at ${path}.`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && child !== null && child !== '' && child !== false) throw new Error(`Adapter output contains secret-like field at ${path}.${key}.`);
    rejectSecretMaterial(child, `${path}.${key}`, depth + 1);
  }
}

function parseRawOutput(raw) {
  rejectSecretMaterial(raw);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.events)) return raw.events;
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    rejectSecretMaterial(parsed);
    return Array.isArray(parsed) ? parsed : parsed?.events;
  }
  throw new Error('Adapter output must contain an events array.');
}

function canonicalArtifact(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\u0000')) throw new Error('Artifact scope is empty or invalid.');
  let decoded;
  try { decoded = decodeURIComponent(raw); }
  catch { throw new Error(`Artifact path is not valid encoding: ${raw}.`); }
  if (decoded.split('/').some(segment => segment === '..' || segment === '.')) throw new Error(`Artifact path traversal is forbidden: ${raw}.`);
  try {
    const url = new URL(decoded);
    url.hash = '';
    return { type: 'url', origin: url.origin, path: url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/' };
  } catch {
    if (decoded.startsWith('/')) throw new Error(`Absolute artifact paths are forbidden: ${raw}.`);
    return { type: 'path', path: decoded.replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '') };
  }
}

function artifactWithinScope(candidate, scope) {
  const value = canonicalArtifact(candidate);
  const boundary = canonicalArtifact(scope);
  if (value.type !== boundary.type) return false;
  if (value.type === 'url' && value.origin !== boundary.origin) return false;
  return value.path === boundary.path || value.path.startsWith(`${boundary.path}/`);
}

function assertArtifactScope(candidate, artifactScope) {
  if (!artifactScope.length) return;
  if (!artifactScope.some(scope => artifactWithinScope(candidate, scope))) throw new Error(`Artifact is outside assignment scope: ${candidate}.`);
}

export function parseAdapterOutput(raw, packet, context = {}) {
  const events = parseRawOutput(raw);
  if (!Array.isArray(events)) throw new Error('Adapter output events are missing.');
  if (events.length > packet.assignment.budget.max_events) throw new Error('Adapter output exceeds event budget.');
  if (JSON.stringify(events).length > packet.assignment.budget.max_chars) throw new Error('Adapter output exceeds character budget.');
  const allowed = new Set(packet.assignment.expected_kinds);
  const targetSet = new Set(packet.assignment.target_ids);
  const artifactScope = packet.assignment.artifact_scope || [];

  return events.map((candidate, index) => {
    const authority = candidate?.authority || {};
    for (const [key, value] of Object.entries(authority)) {
      if (value && FORBIDDEN_AUTHORITY.has(key)) throw new Error(`Forbidden adapter authority: ${key}.`);
    }
    if (FORBIDDEN_EVENT_KINDS.has(candidate?.kind)) throw new Error(`Adapter cannot emit lifecycle or authority event kind (including decision): ${candidate?.kind}.`);
    if (!allowed.has(candidate?.kind) || !COGNITION_KINDS.includes(candidate?.kind)) throw new Error(`Unexpected adapter event kind: ${candidate?.kind}.`);
    const cited = new Set(candidate?.source_event_ids || []);
    if (![...targetSet].some(id => cited.has(id))) throw new Error('Adapter event is missing assignment target citations.');
    if (candidate?.body?.artifacts) for (const artifact of candidate.body.artifacts) assertArtifactScope(artifact, artifactScope);
    if (candidate?.kind === 'artifact') assertArtifactScope(candidate?.body?.uri, artifactScope);
    const issuedAt = candidate?.issued_at || context.issued_at;
    if (!issuedAt) throw new Error('Adapter output requires a trusted issued_at value.');
    return normalizeCognitionEvent({
      ...candidate,
      id: candidate.id || `output:${packet.assignment.id}:${index}`,
      issuer: candidate.issuer || context.issuer || `adapter:${packet.adapter_id}`,
      issued_at: issuedAt,
      visibility: candidate.visibility || 'private',
      source_event_ids: [...new Set([...(candidate.source_event_ids || []), packet.assignment.event_id])]
    });
  });
}

export async function dispatchAssignments({ assignments, memories, adapters, seen = new Set(), now = () => new Date().toISOString() }) {
  const results = [];
  await Promise.all(assignments.map(async assignment => {
    const role = assignment.body.role;
    const adapter = adapters[role] || adapters.default;
    const adapterId = adapter?.id || role;
    const packet = buildRolePacket(assignment, memories[assignment.body.assignment_id] || { events: [] }, adapterId);
    if (seen.has(packet.idempotency_key)) {
      results.push({ assignment_id: assignment.body.assignment_id, status: 'duplicate', packet, events: [] });
      return;
    }
    if (!adapter?.execute) {
      results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', packet, events: [], error: 'adapter unavailable' });
      return;
    }
    seen.add(packet.idempotency_key);
    try {
      const raw = await adapter.execute(packet);
      const events = parseAdapterOutput(raw, packet, { issued_at: now(), issuer: `adapter:${adapterId}` });
      results.push({ assignment_id: assignment.body.assignment_id, status: 'completed', packet, events });
    } catch (error) {
      seen.delete(packet.idempotency_key);
      results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', packet, events: [], error: String(error?.message || error).slice(0, 500) });
    }
  }));
  return results.sort((left, right) => left.assignment_id.localeCompare(right.assignment_id));
}
