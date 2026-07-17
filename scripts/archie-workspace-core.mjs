import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_EVENT_SCHEMA = 'archie-workspace-event/v1';
export const WORKSPACE_STATE_SCHEMA = 'archie-workspace-state/v1';
export const WORKSPACE_CLAIM_BOUNDARY = 'This state records objectives, authority, work, review, evidence, promotion, and rollback. It does not claim intelligence, execution, approval, publication, or completion without the corresponding digest-bound event.';
export const CAPABILITIES = Object.freeze(['read', 'write', 'run', 'contact', 'spend', 'deploy', 'plan', 'review', 'approve']);

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class WorkspaceError extends Error {
  constructor(message, { code = 'workspace_error', status = 400 } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(message = 'Workspace was not found.') { super(message, { code: 'not_found', status: 404 }); }
}

export class WorkspaceAuthorityError extends WorkspaceError {
  constructor(message = 'The principal lacks required authority.') { super(message, { code: 'authority_denied', status: 403 }); }
}

export class WorkspaceConflictError extends WorkspaceError {
  constructor(message = 'Workspace state changed concurrently.') { super(message, { code: 'conflict', status: 409 }); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError(`${label} must be an object.`);
  return value;
}

function text(value, label, { min = 1, max = 20_000 } = {}) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < min || normalized.length > max) throw new WorkspaceError(`${label} must contain ${min}-${max} characters.`);
  return normalized;
}

function optionalText(value, label, options = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return text(value, label, options);
}

function assertId(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_PATTERN.test(normalized)) throw new WorkspaceError(`${label} must match ${ID_PATTERN}.`);
  return normalized;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new WorkspaceError(`${label} must be an array.`);
  const result = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  if (result.length !== values.length) throw new WorkspaceError(`${label} cannot contain blanks or duplicates.`);
  return result;
}

function eventDigest(event) {
  const unsigned = { ...event };
  delete unsigned.event_digest;
  return sha256(stableJSONStringify(unsigned));
}

export function verifyWorkspaceEventStream(events, workspaceId = null) {
  if (!Array.isArray(events)) throw new WorkspaceError('Workspace stream must be an array.');
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.schema !== WORKSPACE_EVENT_SCHEMA) throw new WorkspaceError(`Unsupported workspace event at sequence ${index + 1}.`);
    if (workspaceId && event.workspace_id !== workspaceId) throw new WorkspaceError('Workspace event crossed stream boundaries.');
    if (event.sequence !== index + 1) throw new WorkspaceError(`Workspace event sequence gap at ${index + 1}.`);
    if (event.previous_event_digest !== previous) throw new WorkspaceError(`Workspace event chain mismatch at sequence ${event.sequence}.`);
    if (event.payload_digest !== sha256(stableJSONStringify(event.payload))) throw new WorkspaceError(`Workspace payload digest mismatch at sequence ${event.sequence}.`);
    if (event.event_digest !== eventDigest(event)) throw new WorkspaceError(`Workspace event digest mismatch at sequence ${event.sequence}.`);
    previous = event.event_digest;
  }
  return { count: events.length, head_digest: previous };
}

function emptyState(workspaceId) {
  return {
    schema: WORKSPACE_STATE_SCHEMA,
    workspace_id: workspaceId,
    workspace: null,
    objectives: {},
    agents: {},
    grants: {},
    tasks: {},
    leases: {},
    runs: {},
    artifacts: {},
    reviews: {},
    requested_changes: {},
    evidence: {},
    approvals: {},
    promotions: {},
    publications: {},
    rollbacks: {},
    event_count: 0,
    head_digest: null,
    claim_boundary: WORKSPACE_CLAIM_BOUNDARY
  };
}

export function reduceWorkspaceEvents(events, { workspaceId = events?.[0]?.workspace_id || null, verify = true } = {}) {
  if (verify) verifyWorkspaceEventStream(events, workspaceId);
  const state = emptyState(workspaceId);
  for (const event of events) {
    const payload = event.payload;
    switch (event.type) {
      case 'workspace.created':
        state.workspace = clone(payload.workspace);
        break;
      case 'objective.defined':
        state.objectives[payload.objective.objective_id] = clone(payload.objective);
        break;
      case 'agent.registered':
        state.agents[payload.agent.agent_id] = clone(payload.agent);
        break;
      case 'grant.issued':
        state.grants[payload.grant.grant_id] = clone(payload.grant);
        break;
      case 'grant.revoked':
        if (state.grants[payload.grant_id]) state.grants[payload.grant_id].revoked_at = payload.revoked_at;
        break;
      case 'task_graph.created':
        for (const task of payload.tasks) state.tasks[task.task_id] = clone(task);
        break;
      case 'lease.claimed': {
        const lease = clone(payload.lease);
        state.leases[lease.lease_id] = lease;
        state.tasks[lease.task_id].lease_id = lease.lease_id;
        state.tasks[lease.task_id].status = 'leased';
        break;
      }
      case 'lease.released':
        if (state.leases[payload.lease_id]) state.leases[payload.lease_id].released_at = payload.released_at;
        if (state.tasks[payload.task_id]?.lease_id === payload.lease_id) state.tasks[payload.task_id].lease_id = null;
        break;
      case 'run.started': {
        const run = clone(payload.run);
        state.runs[run.run_id] = run;
        state.tasks[run.task_id].status = 'running';
        break;
      }
      case 'run.event_appended': {
        const run = state.runs[payload.run_id];
        run.event_count += 1;
        run.run_event_head = payload.run_event.digest;
        run.updated_at = payload.run_event.occurred_at;
        break;
      }
      case 'artifact.recorded': {
        const artifact = clone(payload.artifact);
        state.artifacts[artifact.artifact_id] = artifact;
        state.runs[artifact.run_id].artifact_ids.push(artifact.artifact_id);
        break;
      }
      case 'run.completed': {
        const run = state.runs[payload.run_id];
        run.status = payload.status;
        run.completed_at = payload.completed_at;
        run.summary = payload.summary;
        state.tasks[run.task_id].status = payload.status === 'completed' ? 'review' : 'blocked';
        break;
      }
      case 'review.submitted': {
        const review = clone(payload.review);
        state.reviews[review.review_id] = review;
        if (payload.requested_change) {
          state.requested_changes[payload.requested_change.requested_change_id] = clone(payload.requested_change);
          state.tasks[payload.requested_change.task_id].status = 'changes_requested';
        } else if (review.decision === 'approved') {
          const artifact = state.artifacts[review.artifact_id];
          if (artifact) state.tasks[state.runs[artifact.run_id].task_id].status = 'approved';
        }
        break;
      }
      case 'change.resolved': {
        const request = state.requested_changes[payload.requested_change_id];
        request.status = 'resolved';
        request.resolved_at = payload.resolved_at;
        request.resolution_artifact_id = payload.resolution_artifact_id;
        request.resolution_reason = payload.reason;
        state.tasks[request.task_id].status = 'review';
        break;
      }
      case 'evidence.recorded':
        state.evidence[payload.evidence.evidence_id] = clone(payload.evidence);
        break;
      case 'promotion.approved':
        state.approvals[payload.approval.approval_id] = clone(payload.approval);
        state.promotions[payload.promotion.promotion_id] = clone(payload.promotion);
        break;
      case 'result.published':
        state.publications[payload.publication.publication_id] = clone(payload.publication);
        break;
      case 'rollback.recorded':
        state.rollbacks[payload.rollback.rollback_id] = clone(payload.rollback);
        break;
      default:
        throw new WorkspaceError(`Unknown workspace event type: ${event.type}.`);
    }
    state.event_count = event.sequence;
    state.head_digest = event.event_digest;
  }
  return state;
}

function publicProjection(state) {
  return {
    schema: state.schema,
    workspace_id: state.workspace_id,
    workspace: clone(state.workspace),
    objectives: clone(state.objectives),
    agents: clone(state.agents),
    tasks: clone(state.tasks),
    runs: clone(state.runs),
    artifacts: clone(state.artifacts),
    reviews: clone(state.reviews),
    requested_changes: clone(state.requested_changes),
    evidence: clone(state.evidence),
    approvals: clone(state.approvals),
    promotions: clone(state.promotions),
    publications: clone(state.publications),
    rollbacks: clone(state.rollbacks),
    event_count: state.event_count,
    head_digest: state.head_digest,
    claim_boundary: state.claim_boundary
  };
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function grantActive(grant, now) {
  return !grant.revoked_at && (!grant.expires_at || timestampMs(grant.expires_at) > timestampMs(now));
}

function capabilitiesFor(state, principalId, now, { taskId = null } = {}) {
  if (!state.workspace) return new Set();
  if (principalId === state.workspace.owner_id) return new Set(CAPABILITIES);
  const capabilities = new Set();
  for (const grant of Object.values(state.grants)) {
    if (grant.principal_id !== principalId || !grantActive(grant, now)) continue;
    if (grant.task_id && grant.task_id !== taskId) continue;
    for (const capability of grant.capabilities) capabilities.add(capability);
  }
  return capabilities;
}

function requireCapabilities(state, principalId, now, required, options = {}) {
  if (!principalId) throw new WorkspaceAuthorityError('A principal identity is required for mutation.');
  const actual = capabilitiesFor(state, principalId, now, options);
  const missing = required.filter(capability => !actual.has(capability));
  if (missing.length) throw new WorkspaceAuthorityError(`Principal ${principalId} lacks: ${missing.join(', ')}.`);
}

function activeLeaseForTask(state, taskId, now) {
  return Object.values(state.leases).find(lease => lease.task_id === taskId && !lease.released_at && timestampMs(lease.expires_at) > timestampMs(now)) || null;
}

function ensureWorkspace(state) {
  if (!state.workspace) throw new WorkspaceNotFoundError();
}

function ensureAcyclic(tasks, existingTasks) {
  const all = new Map([...Object.values(existingTasks), ...tasks].map(task => [task.task_id, task]));
  const temporary = new Set();
  const permanent = new Set();
  function visit(taskId) {
    if (permanent.has(taskId)) return;
    if (temporary.has(taskId)) throw new WorkspaceError(`Task graph cycle includes ${taskId}.`);
    const task = all.get(taskId);
    if (!task) throw new WorkspaceError(`Task dependency ${taskId} does not exist.`);
    temporary.add(taskId);
    for (const dependency of task.depends_on) visit(dependency);
    temporary.delete(taskId);
    permanent.add(taskId);
  }
  for (const task of tasks) visit(task.task_id);
}

export class MemoryWorkspaceProvider {
  constructor() {
    this.streams = new Map();
    this.artifacts = new Map();
  }

  async listWorkspaceIds() { return [...this.streams.keys()].sort(); }
  async readEvents(workspaceId) { return clone(this.streams.get(workspaceId) || []); }

  async appendEvent(workspaceId, expectedHead, event) {
    const events = this.streams.get(workspaceId) || [];
    const actualHead = events.at(-1)?.event_digest || null;
    if (actualHead !== expectedHead) throw new WorkspaceConflictError();
    events.push(clone(event));
    this.streams.set(workspaceId, events);
  }

  async putArtifact(workspaceId, digest, bytes) {
    this.artifacts.set(`${workspaceId}:${digest}`, Buffer.from(bytes));
    return `memory://${workspaceId}/${digest}`;
  }

  async readArtifact(workspaceId, digest) {
    const value = this.artifacts.get(`${workspaceId}:${digest}`);
    if (!value) throw new WorkspaceNotFoundError('Artifact bytes were not found.');
    return Buffer.from(value);
  }
}

async function acquireLock(lockPath, { attempts = 200, delayMs = 10 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fs.open(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new WorkspaceConflictError('Could not acquire workspace writer lease.');
}

export class FileWorkspaceProvider {
  constructor(root) {
    this.root = path.resolve(root);
  }

  workspaceDirectory(workspaceId) { return path.join(this.root, assertId(workspaceId, 'workspace_id')); }
  eventPath(workspaceId) { return path.join(this.workspaceDirectory(workspaceId), 'events.jsonl'); }
  artifactPath(workspaceId, digest) {
    if (!SHA256_PATTERN.test(digest)) throw new WorkspaceError('Artifact digest must be SHA-256.');
    return path.join(this.workspaceDirectory(workspaceId), 'artifacts', digest);
  }

  async listWorkspaceIds() {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && ID_PATTERN.test(entry.name)).map(entry => entry.name).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async readEvents(workspaceId) {
    try {
      const contents = await fs.readFile(this.eventPath(workspaceId), 'utf8');
      const events = contents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      verifyWorkspaceEventStream(events, workspaceId);
      return events;
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async appendEvent(workspaceId, expectedHead, event) {
    const directory = this.workspaceDirectory(workspaceId);
    await fs.mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, '.writer.lock');
    const lock = await acquireLock(lockPath);
    try {
      const events = await this.readEvents(workspaceId);
      const actualHead = events.at(-1)?.event_digest || null;
      if (actualHead !== expectedHead) throw new WorkspaceConflictError();
      await fs.appendFile(this.eventPath(workspaceId), `${stableJSONStringify(event)}\n`, { encoding: 'utf8' });
    } finally {
      await lock.close();
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async putArtifact(workspaceId, digest, bytes) {
    const target = this.artifactPath(workspaceId, digest);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(target);
      if (sha256(existing) !== digest) throw new WorkspaceConflictError('Existing artifact bytes do not match their digest.');
    }
    return `file://${target.replaceAll('\\', '/')}`;
  }

  async readArtifact(workspaceId, digest) {
    try {
      const bytes = await fs.readFile(this.artifactPath(workspaceId, digest));
      if (sha256(bytes) !== digest) throw new WorkspaceError('Stored artifact digest mismatch.');
      return bytes;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new WorkspaceNotFoundError('Artifact bytes were not found.');
      throw error;
    }
  }
}

export function createWorkspaceEngine({
  provider,
  clock = () => new Date().toISOString(),
  idFactory = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}) {
  if (!provider || typeof provider.readEvents !== 'function' || typeof provider.appendEvent !== 'function') {
    throw new WorkspaceError('A provider-neutral workspace adapter is required.');
  }

  async function readState(workspaceId) {
    const id = assertId(workspaceId, 'workspace_id');
    const events = await provider.readEvents(id);
    return { events, state: reduceWorkspaceEvents(events, { workspaceId: id }) };
  }

  async function commit(workspaceId, actorId, type, payload) {
    const { events } = await readState(workspaceId);
    const previous = events.at(-1)?.event_digest || null;
    const occurredAt = clock();
    const event = {
      schema: WORKSPACE_EVENT_SCHEMA,
      event_id: assertId(idFactory('event'), 'event_id'),
      workspace_id: workspaceId,
      sequence: events.length + 1,
      type,
      actor_id: assertId(actorId, 'actor_id'),
      occurred_at: occurredAt,
      previous_event_digest: previous,
      payload: canonical(payload),
      payload_digest: sha256(stableJSONStringify(payload))
    };
    event.event_digest = eventDigest(event);
    await provider.appendEvent(workspaceId, previous, event);
    const nextEvents = [...events, event];
    return { event: clone(event), state: reduceWorkspaceEvents(nextEvents, { workspaceId }) };
  }

  async function createWorkspace({ workspace_id, title, visibility = 'private', owner_id }) {
    const ownerId = assertId(owner_id, 'owner_id');
    const workspaceId = assertId(workspace_id || idFactory('workspace'), 'workspace_id');
    if (!['public', 'private', 'locally_sealed'].includes(visibility)) throw new WorkspaceError('visibility must be public, private, or locally_sealed.');
    const existing = await provider.readEvents(workspaceId);
    if (existing.length) throw new WorkspaceConflictError(`Workspace ${workspaceId} already exists.`);
    const createdAt = clock();
    const workspace = {
      schema: 'archie-workspace/v1',
      workspace_id: workspaceId,
      title: text(title, 'title', { max: 200 }),
      visibility,
      owner_id: ownerId,
      created_at: createdAt,
      claim_boundary: WORKSPACE_CLAIM_BOUNDARY
    };
    return commit(workspaceId, ownerId, 'workspace.created', { workspace });
  }

  async function execute(workspaceId, actorId, command, rawPayload = {}) {
    const principalId = assertId(actorId, 'actor_id');
    const payload = assertObject(rawPayload, 'payload');
    const { state } = await readState(workspaceId);
    ensureWorkspace(state);
    const now = clock();

    switch (command) {
      case 'objective.define': {
        requireCapabilities(state, principalId, now, ['write']);
        const objective = {
          schema: 'archie-objective/v1',
          objective_id: assertId(payload.objective_id || idFactory('objective'), 'objective_id'),
          workspace_id: workspaceId,
          statement: text(payload.statement, 'statement'),
          protected_reality: optionalText(payload.protected_reality, 'protected_reality'),
          proof_of_done: optionalText(payload.proof_of_done, 'proof_of_done'),
          status: 'active',
          created_by: principalId,
          created_at: now
        };
        objective.objective_digest = sha256(stableJSONStringify(objective));
        return commit(workspaceId, principalId, 'objective.defined', { objective });
      }
      case 'agent.register': {
        requireCapabilities(state, principalId, now, ['write']);
        const agent = {
          schema: 'archie-agent-identity/v1',
          agent_id: assertId(payload.agent_id || idFactory('agent'), 'agent_id'),
          label: text(payload.label, 'label', { max: 160 }),
          kind: ['human', 'model', 'policy', 'service'].includes(payload.kind) ? payload.kind : 'model',
          provider: optionalText(payload.provider, 'provider', { max: 200 }),
          registered_by: principalId,
          registered_at: now
        };
        return commit(workspaceId, principalId, 'agent.registered', { agent });
      }
      case 'grant.issue': {
        if (principalId !== state.workspace.owner_id) throw new WorkspaceAuthorityError('Only the workspace owner may issue grants in the local tranche.');
        const capabilities = uniqueStrings(payload.capabilities, 'capabilities');
        for (const capability of capabilities) if (!CAPABILITIES.includes(capability)) throw new WorkspaceError(`Unknown capability: ${capability}.`);
        const grant = {
          schema: 'archie-capability-grant/v1',
          grant_id: assertId(payload.grant_id || idFactory('grant'), 'grant_id'),
          workspace_id: workspaceId,
          principal_id: assertId(payload.principal_id, 'principal_id'),
          capabilities,
          task_id: payload.task_id ? assertId(payload.task_id, 'task_id') : null,
          issued_by: principalId,
          issued_at: now,
          expires_at: payload.expires_at ? new Date(payload.expires_at).toISOString() : null,
          revoked_at: null
        };
        if (grant.task_id && !state.tasks[grant.task_id]) throw new WorkspaceNotFoundError(`Task ${grant.task_id} was not found.`);
        return commit(workspaceId, principalId, 'grant.issued', { grant });
      }
      case 'grant.revoke': {
        if (principalId !== state.workspace.owner_id) throw new WorkspaceAuthorityError('Only the workspace owner may revoke grants.');
        const grantId = assertId(payload.grant_id, 'grant_id');
        if (!state.grants[grantId]) throw new WorkspaceNotFoundError(`Grant ${grantId} was not found.`);
        return commit(workspaceId, principalId, 'grant.revoked', { grant_id: grantId, revoked_at: now });
      }
      case 'task_graph.create': {
        requireCapabilities(state, principalId, now, ['plan', 'write']);
        const objectiveId = assertId(payload.objective_id, 'objective_id');
        if (!state.objectives[objectiveId]) throw new WorkspaceNotFoundError(`Objective ${objectiveId} was not found.`);
        if (!Array.isArray(payload.tasks) || payload.tasks.length < 1 || payload.tasks.length > 200) throw new WorkspaceError('tasks must contain 1-200 tasks.');
        const tasks = payload.tasks.map((input, index) => {
          assertObject(input, `tasks[${index}]`);
          const taskId = assertId(input.task_id || idFactory('task'), `tasks[${index}].task_id`);
          if (state.tasks[taskId]) throw new WorkspaceConflictError(`Task ${taskId} already exists.`);
          return {
            schema: 'archie-task/v1',
            task_id: taskId,
            workspace_id: workspaceId,
            objective_id: objectiveId,
            title: text(input.title, `tasks[${index}].title`, { max: 200 }),
            description: text(input.description || input.title, `tasks[${index}].description`),
            depends_on: uniqueStrings(input.depends_on || [], `tasks[${index}].depends_on`).map(value => assertId(value, 'dependency task_id')),
            status: 'open',
            lease_id: null,
            created_by: principalId,
            created_at: now
          };
        });
        if (new Set(tasks.map(task => task.task_id)).size !== tasks.length) throw new WorkspaceError('Task IDs must be unique.');
        ensureAcyclic(tasks, state.tasks);
        const taskGraphDigest = sha256(stableJSONStringify(tasks));
        return commit(workspaceId, principalId, 'task_graph.created', { objective_id: objectiveId, task_graph_digest: taskGraphDigest, tasks });
      }
      case 'lease.claim': {
        const taskId = assertId(payload.task_id, 'task_id');
        const task = state.tasks[taskId];
        if (!task) throw new WorkspaceNotFoundError(`Task ${taskId} was not found.`);
        if (!state.agents[principalId]) throw new WorkspaceNotFoundError(`Agent ${principalId} is not registered.`);
        requireCapabilities(state, principalId, now, ['write', 'run'], { taskId });
        const existing = activeLeaseForTask(state, taskId, now);
        if (existing && existing.agent_id !== principalId) throw new WorkspaceConflictError(`Task ${taskId} is leased to ${existing.agent_id}.`);
        if (existing) return { event: null, state };
        const ttlMs = Number(payload.ttl_ms ?? 3_600_000);
        if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new WorkspaceError('ttl_ms must be 1000-86400000.');
        const lease = {
          schema: 'archie-task-lease/v1',
          lease_id: assertId(payload.lease_id || idFactory('lease'), 'lease_id'),
          workspace_id: workspaceId,
          task_id: taskId,
          agent_id: principalId,
          claimed_at: now,
          expires_at: new Date(timestampMs(now) + ttlMs).toISOString(),
          released_at: null
        };
        return commit(workspaceId, principalId, 'lease.claimed', { lease });
      }
      case 'run.start': {
        const taskId = assertId(payload.task_id, 'task_id');
        const lease = activeLeaseForTask(state, taskId, now);
        if (!lease || lease.agent_id !== principalId) throw new WorkspaceAuthorityError('An active task lease owned by the agent is required.');
        requireCapabilities(state, principalId, now, ['run'], { taskId });
        const run = {
          schema: 'archie-run/v1',
          run_id: assertId(payload.run_id || idFactory('run'), 'run_id'),
          workspace_id: workspaceId,
          task_id: taskId,
          agent_id: principalId,
          lease_id: lease.lease_id,
          parent_run_id: payload.parent_run_id ? assertId(payload.parent_run_id, 'parent_run_id') : null,
          status: 'running',
          started_at: now,
          completed_at: null,
          summary: null,
          event_count: 0,
          run_event_head: null,
          artifact_ids: []
        };
        if (run.parent_run_id && !state.runs[run.parent_run_id]) throw new WorkspaceNotFoundError(`Parent run ${run.parent_run_id} was not found.`);
        return commit(workspaceId, principalId, 'run.started', { run });
      }
      case 'run.append_event': {
        const runId = assertId(payload.run_id, 'run_id');
        const run = state.runs[runId];
        if (!run) throw new WorkspaceNotFoundError(`Run ${runId} was not found.`);
        if (run.agent_id !== principalId || run.status !== 'running') throw new WorkspaceAuthorityError('Only the running agent may append run events.');
        const runEvent = {
          schema: 'archie-run-event/v1',
          kind: text(payload.kind || 'progress', 'kind', { max: 80 }),
          summary: text(payload.summary, 'summary'),
          occurred_at: now,
          previous_digest: run.run_event_head
        };
        runEvent.digest = sha256(stableJSONStringify(runEvent));
        return commit(workspaceId, principalId, 'run.event_appended', { run_id: runId, run_event: runEvent });
      }
      case 'artifact.record': {
        const runId = assertId(payload.run_id, 'run_id');
        const run = state.runs[runId];
        if (!run) throw new WorkspaceNotFoundError(`Run ${runId} was not found.`);
        if (run.agent_id !== principalId || run.status !== 'running') throw new WorkspaceAuthorityError('Only the running agent may record artifacts.');
        let bytes;
        if (payload.content_base64 !== undefined) bytes = Buffer.from(String(payload.content_base64), 'base64');
        else if (payload.content !== undefined) bytes = Buffer.from(String(payload.content), 'utf8');
        else throw new WorkspaceError('artifact.record requires content or content_base64.');
        if (bytes.length < 1 || bytes.length > 50 * 1024 * 1024) throw new WorkspaceError('Artifact bytes must be 1-52428800 bytes.');
        const digest = sha256(bytes);
        const providerUri = await provider.putArtifact(workspaceId, digest, bytes);
        const artifact = {
          schema: 'archie-artifact/v1',
          artifact_id: assertId(payload.artifact_id || idFactory('artifact'), 'artifact_id'),
          workspace_id: workspaceId,
          run_id: runId,
          name: text(payload.name || 'result', 'name', { max: 240 }),
          media_type: text(payload.media_type || 'application/octet-stream', 'media_type', { max: 160 }),
          sha256: digest,
          size_bytes: bytes.length,
          provider_uri: providerUri,
          created_by: principalId,
          created_at: now
        };
        return commit(workspaceId, principalId, 'artifact.recorded', { artifact });
      }
      case 'run.complete': {
        const runId = assertId(payload.run_id, 'run_id');
        const run = state.runs[runId];
        if (!run) throw new WorkspaceNotFoundError(`Run ${runId} was not found.`);
        if (run.agent_id !== principalId || run.status !== 'running') throw new WorkspaceAuthorityError('Only the running agent may complete a run.');
        const status = payload.status === 'blocked' ? 'blocked' : 'completed';
        if (status === 'completed' && run.artifact_ids.length < 1) throw new WorkspaceError('A completed run requires at least one artifact.');
        return commit(workspaceId, principalId, 'run.completed', {
          run_id: runId,
          status,
          completed_at: now,
          summary: text(payload.summary, 'summary')
        });
      }
      case 'review.submit': {
        requireCapabilities(state, principalId, now, ['review']);
        const artifactId = assertId(payload.artifact_id, 'artifact_id');
        const artifact = state.artifacts[artifactId];
        if (!artifact) throw new WorkspaceNotFoundError(`Artifact ${artifactId} was not found.`);
        const run = state.runs[artifact.run_id];
        if (run.agent_id === principalId) throw new WorkspaceAuthorityError('The producing agent cannot independently review its own artifact.');
        if (!['approved', 'changes_requested'].includes(payload.decision)) throw new WorkspaceError('review decision must be approved or changes_requested.');
        const review = {
          schema: 'archie-review/v1',
          review_id: assertId(payload.review_id || idFactory('review'), 'review_id'),
          workspace_id: workspaceId,
          artifact_id: artifactId,
          reviewer_id: principalId,
          decision: payload.decision,
          reason: text(payload.reason, 'reason'),
          submitted_at: now
        };
        const requestedChange = payload.decision === 'changes_requested' ? {
          schema: 'archie-requested-change/v1',
          requested_change_id: assertId(payload.requested_change_id || idFactory('change'), 'requested_change_id'),
          workspace_id: workspaceId,
          task_id: run.task_id,
          review_id: review.review_id,
          request: text(payload.request || payload.reason, 'request'),
          status: 'open',
          requested_by: principalId,
          requested_at: now,
          resolved_at: null,
          resolution_artifact_id: null
        } : null;
        return commit(workspaceId, principalId, 'review.submitted', { review, requested_change: requestedChange });
      }
      case 'change.resolve': {
        const requestId = assertId(payload.requested_change_id, 'requested_change_id');
        const request = state.requested_changes[requestId];
        if (!request) throw new WorkspaceNotFoundError(`Requested change ${requestId} was not found.`);
        if (request.status !== 'open') throw new WorkspaceConflictError(`Requested change ${requestId} is already resolved.`);
        requireCapabilities(state, principalId, now, ['write', 'run'], { taskId: request.task_id });
        const lease = activeLeaseForTask(state, request.task_id, now);
        if (!lease || lease.agent_id !== principalId) throw new WorkspaceAuthorityError('The repairing agent must own the active task lease.');
        const artifactId = assertId(payload.resolution_artifact_id, 'resolution_artifact_id');
        const artifact = state.artifacts[artifactId];
        if (!artifact || state.runs[artifact.run_id].task_id !== request.task_id) throw new WorkspaceError('Resolution artifact must belong to the requested task.');
        return commit(workspaceId, principalId, 'change.resolved', {
          requested_change_id: requestId,
          resolution_artifact_id: artifactId,
          reason: text(payload.reason, 'reason'),
          resolved_at: now
        });
      }
      case 'evidence.record': {
        requireCapabilities(state, principalId, now, ['review']);
        const runId = assertId(payload.run_id, 'run_id');
        const run = state.runs[runId];
        if (!run) throw new WorkspaceNotFoundError(`Run ${runId} was not found.`);
        if (run.agent_id === principalId) throw new WorkspaceAuthorityError('The producing agent cannot issue independent evidence for its own run.');
        const checks = uniqueStrings(payload.checks || [], 'checks');
        if (!checks.length) throw new WorkspaceError('At least one evidence check is required.');
        const evidence = {
          schema: 'archie-evidence-receipt/v1',
          evidence_id: assertId(payload.evidence_id || idFactory('evidence'), 'evidence_id'),
          workspace_id: workspaceId,
          run_id: runId,
          evaluator_id: principalId,
          result: payload.result === 'pass' ? 'pass' : 'fail',
          checks,
          summary: text(payload.summary, 'summary'),
          created_at: now
        };
        evidence.receipt_digest = sha256(stableJSONStringify(evidence));
        return commit(workspaceId, principalId, 'evidence.recorded', { evidence });
      }
      case 'promotion.approve': {
        requireCapabilities(state, principalId, now, ['approve']);
        const runId = assertId(payload.run_id, 'run_id');
        const run = state.runs[runId];
        if (!run || run.status !== 'completed') throw new WorkspaceError('Promotion requires a completed run.');
        const artifactId = assertId(payload.artifact_id, 'artifact_id');
        if (!run.artifact_ids.includes(artifactId)) throw new WorkspaceError('Promotion artifact must belong to the run.');
        const openChanges = Object.values(state.requested_changes).filter(change => change.task_id === run.task_id && change.status === 'open');
        if (openChanges.length) throw new WorkspaceError('Promotion is blocked by unresolved requested changes.');
        const approvedReview = Object.values(state.reviews).find(review => review.artifact_id === artifactId && review.decision === 'approved');
        if (!approvedReview) throw new WorkspaceError('Promotion requires an approved independent review of the artifact.');
        const passingEvidence = Object.values(state.evidence).filter(item => item.run_id === runId && item.result === 'pass');
        if (!passingEvidence.length) throw new WorkspaceError('Promotion requires passing independent evidence.');
        const approval = {
          schema: 'archie-approval/v1',
          approval_id: assertId(payload.approval_id || idFactory('approval'), 'approval_id'),
          workspace_id: workspaceId,
          principal_id: principalId,
          run_id: runId,
          artifact_id: artifactId,
          reason: text(payload.reason, 'reason'),
          approved_at: now
        };
        const promotion = {
          schema: 'archie-promotion-decision/v1',
          promotion_id: assertId(payload.promotion_id || idFactory('promotion'), 'promotion_id'),
          workspace_id: workspaceId,
          run_id: runId,
          artifact_id: artifactId,
          approval_id: approval.approval_id,
          review_id: approvedReview.review_id,
          evidence_ids: passingEvidence.map(item => item.evidence_id).sort(),
          decision: 'approved',
          decided_at: now
        };
        promotion.decision_digest = sha256(stableJSONStringify(promotion));
        return commit(workspaceId, principalId, 'promotion.approved', { approval, promotion });
      }
      case 'result.publish': {
        requireCapabilities(state, principalId, now, ['deploy']);
        const promotionId = assertId(payload.promotion_id, 'promotion_id');
        const promotion = state.promotions[promotionId];
        if (!promotion || promotion.decision !== 'approved') throw new WorkspaceError('Publication requires an approved promotion decision.');
        const publication = {
          schema: 'archie-publication/v1',
          publication_id: assertId(payload.publication_id || idFactory('publication'), 'publication_id'),
          workspace_id: workspaceId,
          promotion_id: promotionId,
          stable_url: optionalText(payload.stable_url, 'stable_url', { max: 2_000 }) || `archie://workspace/${workspaceId}/results/${promotionId}`,
          published_by: principalId,
          published_at: now,
          rollback_available: true
        };
        publication.publication_digest = sha256(stableJSONStringify(publication));
        return commit(workspaceId, principalId, 'result.published', { publication });
      }
      case 'rollback.record': {
        requireCapabilities(state, principalId, now, ['deploy']);
        const publicationId = assertId(payload.publication_id, 'publication_id');
        const publication = state.publications[publicationId];
        if (!publication) throw new WorkspaceNotFoundError(`Publication ${publicationId} was not found.`);
        const rollback = {
          schema: 'archie-rollback-receipt/v1',
          rollback_id: assertId(payload.rollback_id || idFactory('rollback'), 'rollback_id'),
          workspace_id: workspaceId,
          publication_id: publicationId,
          promotion_id: publication.promotion_id,
          reason: text(payload.reason, 'reason'),
          target_publication_id: payload.target_publication_id ? assertId(payload.target_publication_id, 'target_publication_id') : null,
          recorded_by: principalId,
          recorded_at: now
        };
        if (rollback.target_publication_id && !state.publications[rollback.target_publication_id]) throw new WorkspaceNotFoundError('Rollback target publication was not found.');
        rollback.receipt_digest = sha256(stableJSONStringify(rollback));
        return commit(workspaceId, principalId, 'rollback.recorded', { rollback });
      }
      default:
        throw new WorkspaceError(`Unknown workspace command: ${command}.`);
    }
  }

  async function inspect(workspaceId, { principalId = null } = {}) {
    const { state } = await readState(workspaceId);
    ensureWorkspace(state);
    const now = clock();
    const mayRead = state.workspace.visibility === 'public'
      || (principalId && capabilitiesFor(state, principalId, now).has('read'));
    if (!mayRead) throw new WorkspaceAuthorityError('This workspace is not publicly readable.');
    return publicProjection(state);
  }

  async function listPublic() {
    const results = [];
    for (const workspaceId of await provider.listWorkspaceIds()) {
      const { state } = await readState(workspaceId);
      if (state.workspace?.visibility === 'public') {
        results.push({
          workspace_id: workspaceId,
          title: state.workspace.title,
          event_count: state.event_count,
          head_digest: state.head_digest,
          latest_publication: Object.values(state.publications).at(-1) || null
        });
      }
    }
    return results;
  }

  async function events(workspaceId, { principalId = null } = {}) {
    await inspect(workspaceId, { principalId });
    const stream = await provider.readEvents(workspaceId);
    return clone(stream);
  }

  async function readArtifact(workspaceId, artifactId, { principalId = null } = {}) {
    const projection = await inspect(workspaceId, { principalId });
    const artifact = projection.artifacts[artifactId];
    if (!artifact) throw new WorkspaceNotFoundError(`Artifact ${artifactId} was not found.`);
    return { artifact, bytes: await provider.readArtifact(workspaceId, artifact.sha256) };
  }

  return Object.freeze({ provider, createWorkspace, execute, inspect, listPublic, events, readArtifact, readState });
}
