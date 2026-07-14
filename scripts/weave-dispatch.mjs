import { createHash } from 'node:crypto';
import { COGNITION_KINDS, normalizeCognitionEvent } from './weave-cognition.mjs';

const FORBIDDEN_AUTHORITY = new Set(['merge', 'deploy', 'grant', 'admin', 'canonical_mutation', 'repo:write']);
const SECRET_PATTERN = /(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[^\s]+/i;

export function dispatchIdempotencyKey({ wave_id, assignment_id, adapter_id }) {
  return createHash('sha256').update(`${wave_id}|${assignment_id}|${adapter_id}`).digest('hex');
}

export function buildRolePacket(assignmentEvent, memory, adapterId) {
  if (assignmentEvent?.kind !== 'assignment') throw new Error('Assignment event required.');
  const body = assignmentEvent.body;
  return Object.freeze({
    protocol: 'sideways-role-packet',
    version: 1,
    idempotency_key: dispatchIdempotencyKey({ wave_id: body.wave_id, assignment_id: body.assignment_id, adapter_id: adapterId }),
    adapter_id: adapterId,
    assignment: {
      id: body.assignment_id,
      wave_id: body.wave_id,
      role: body.role,
      target_ids: body.target_ids,
      expected_kinds: body.expected_kinds,
      completion_criteria: body.completion_criteria,
      budget: body.budget,
      artifact_scope: body.artifact_scope
    },
    memory,
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

function parseRawOutput(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.events)) return raw.events;
  if (typeof raw === 'string') {
    if (SECRET_PATTERN.test(raw)) throw new Error('Adapter output contains secret-like material.');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.events;
  }
  throw new Error('Adapter output must contain an events array.');
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
    if (!allowed.has(candidate?.kind) || !COGNITION_KINDS.includes(candidate?.kind)) throw new Error(`Unexpected adapter event kind: ${candidate?.kind}.`);
    const cited = new Set(candidate?.source_event_ids || []);
    if (![...targetSet].some(id => cited.has(id))) throw new Error('Adapter event is missing assignment target citations.');
    if (candidate?.body?.artifacts && artifactScope.length) {
      for (const artifact of candidate.body.artifacts) {
        if (!artifactScope.some(scope => String(artifact).startsWith(scope))) throw new Error(`Artifact is outside assignment scope: ${artifact}.`);
      }
    }
    return normalizeCognitionEvent({
      ...candidate,
      id: candidate.id || `output:${packet.assignment.id}:${index}`,
      issuer: candidate.issuer || context.issuer || `adapter:${packet.adapter_id}`,
      issued_at: candidate.issued_at || context.issued_at || new Date().toISOString(),
      visibility: candidate.visibility || 'private',
      source_event_ids: candidate.source_event_ids
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
    seen.add(packet.idempotency_key);
    if (!adapter?.execute) {
      results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', packet, events: [], error: 'adapter unavailable' });
      return;
    }
    try {
      const raw = await adapter.execute(packet);
      const events = parseAdapterOutput(raw, packet, { issued_at: now(), issuer: `adapter:${adapterId}` });
      results.push({ assignment_id: assignment.body.assignment_id, status: 'completed', packet, events });
    } catch (error) {
      results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', packet, events: [], error: String(error?.message || error).slice(0, 500) });
    }
  }));
  return results.sort((left, right) => left.assignment_id.localeCompare(right.assignment_id));
}
