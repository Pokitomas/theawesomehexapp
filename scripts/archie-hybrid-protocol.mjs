import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceAuthorityError,
  WorkspaceConflictError,
  WorkspaceError,
  sha256,
  stableJSONStringify
} from './archie-workspace-core.mjs';

export const ARCHIE_HYBRID_PROTOCOL_SCHEMA = 'archie-hybrid-runner-protocol/v1';
export const ARCHIE_HYBRID_PROTOCOL_VERSION = '1.0.0';
export const ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA = 'archie-hybrid-runner-advertisement/v1';
export const ARCHIE_HYBRID_OFFER_SCHEMA = 'archie-hybrid-work-offer/v1';
export const ARCHIE_HYBRID_LEASE_SCHEMA = 'archie-hybrid-fenced-lease/v1';
export const ARCHIE_HYBRID_EVENT_SCHEMA = 'archie-hybrid-run-event/v1';
export const ARCHIE_HYBRID_TERMINAL_SCHEMA = 'archie-hybrid-terminal-receipt/v1';
export const ARCHIE_HYBRID_FAILURE_SCHEMA = 'archie-hybrid-failure-receipt/v1';
const REGISTRY_SCHEMA = 'archie-hybrid-registry/v1';
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const ALLOWED_CAPABILITIES = Object.freeze([
  'directory.read',
  'directory.write',
  'process.verify',
  'artifact.upload',
  'event.stream',
  'resume'
]);
const FORBIDDEN_CAPABILITY_PATTERN = /(contact|spend|purchase|deploy|publish|network|credential|secret|unbounded|shell|admin)/i;

function id(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_PATTERN.test(normalized)) throw new WorkspaceError(`${label} is invalid.`);
  return normalized;
}

function text(value, label, { min = 1, max = 20_000 } = {}) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').trim();
  if (normalized.length < min || normalized.length > max) throw new WorkspaceError(`${label} must contain ${min}-${max} characters.`);
  return normalized;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new WorkspaceError(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function digest(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new WorkspaceError(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function uniqueStrings(value, label, { min = 0, max = 64 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new WorkspaceError(`${label} must contain ${min}-${max} strings.`);
  const result = [...new Set(value.map((entry, index) => text(entry, `${label}[${index}]`, { max: 160 })))];
  if (result.length !== value.length) throw new WorkspaceError(`${label} must not contain duplicates.`);
  return result;
}

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenDigest(value) {
  return sha256(`archie-hybrid-token/v1\0${String(value || '')}`);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function relativeFile(value, label) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.includes('\u0000')) {
    throw new WorkspaceError(`${label} must be a relative path without traversal.`);
  }
  return normalized;
}

function pathAllowed(filename, patterns) {
  return patterns.some(pattern => pattern.endsWith('/**')
    ? filename === pattern.slice(0, -3) || filename.startsWith(pattern.slice(0, -2))
    : filename === pattern);
}

function normalizeAdvertisement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA) {
    throw new WorkspaceError(`Runner advertisement must use ${ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA}.`);
  }
  const capabilities = uniqueStrings(value.capabilities, 'capabilities', { min: 1 });
  for (const capability of capabilities) {
    if (!ALLOWED_CAPABILITIES.includes(capability) || FORBIDDEN_CAPABILITY_PATTERN.test(capability)) {
      throw new WorkspaceAuthorityError(`Runner capability is not admitted: ${capability}.`);
    }
  }
  const privacy = value.privacy || {};
  if (privacy.inbound_access !== false) throw new WorkspaceAuthorityError('Hybrid runners must advertise inbound_access=false.');
  if (privacy.filesystem_scope !== 'bounded_root') throw new WorkspaceAuthorityError('Hybrid runners must use a bounded filesystem root.');
  if (privacy.artifact_upload !== 'explicit_only') throw new WorkspaceAuthorityError('Hybrid runners must upload explicitly admitted artifacts only.');
  if (privacy.credentials !== 'local_only') throw new WorkspaceAuthorityError('Hybrid runner credentials and model state must remain local.');
  const resources = value.resources || {};
  return Object.freeze({
    schema: ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA,
    protocol_version: text(value.protocol_version, 'protocol_version', { max: 40 }),
    runner_version: text(value.runner_version, 'runner_version', { max: 80 }),
    capabilities: Object.freeze(capabilities.sort()),
    resources: Object.freeze({
      platform: text(resources.platform, 'resources.platform', { max: 80 }),
      architecture: text(resources.architecture, 'resources.architecture', { max: 80 }),
      cpu_count: integer(resources.cpu_count, 'resources.cpu_count', { min: 1, max: 4096 }),
      memory_bytes: integer(resources.memory_bytes, 'resources.memory_bytes', { min: 1 }),
      disk_free_bytes: integer(resources.disk_free_bytes, 'resources.disk_free_bytes', { min: 1 })
    }),
    privacy: Object.freeze({
      inbound_access: false,
      filesystem_scope: 'bounded_root',
      artifact_upload: 'explicit_only',
      credentials: 'local_only'
    })
  });
}

function normalizeArtifactAdmission(value, allowedPaths) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new WorkspaceError('artifact_admission must contain 1-64 entries.');
  const entries = value.map((entry, index) => {
    const artifactId = id(entry?.artifact_id, `artifact_admission[${index}].artifact_id`);
    const filename = relativeFile(entry?.path, `artifact_admission[${index}].path`);
    if (!pathAllowed(filename, allowedPaths)) throw new WorkspaceAuthorityError(`Artifact path is outside the write fence: ${filename}.`);
    return Object.freeze({
      artifact_id: artifactId,
      path: filename,
      name: text(entry?.name || path.posix.basename(filename), `artifact_admission[${index}].name`, { max: 240 }),
      media_type: text(entry?.media_type || 'application/octet-stream', `artifact_admission[${index}].media_type`, { max: 160 }),
      required: entry?.required !== false,
      max_bytes: integer(entry?.max_bytes ?? MAX_ARTIFACT_BYTES, `artifact_admission[${index}].max_bytes`, { min: 1, max: MAX_ARTIFACT_BYTES }),
      sha256: entry?.sha256 ? digest(entry.sha256, `artifact_admission[${index}].sha256`) : null
    });
  });
  if (new Set(entries.map(entry => entry.artifact_id)).size !== entries.length) throw new WorkspaceError('Artifact admission IDs must be unique.');
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new WorkspaceError('Artifact admission paths must be unique.');
  return Object.freeze(entries);
}

function normalizeExecution(value, allowedPaths) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'archie-hybrid-materialize-files/v1') {
    throw new WorkspaceError('The first hybrid tranche supports archie-hybrid-materialize-files/v1 only.');
  }
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 64) throw new WorkspaceError('execution.files must contain 1-64 entries.');
  const files = value.files.map((entry, index) => {
    const filename = relativeFile(entry?.path, `execution.files[${index}].path`);
    if (!pathAllowed(filename, allowedPaths)) throw new WorkspaceAuthorityError(`Execution path is outside the write fence: ${filename}.`);
    const bytes = Buffer.from(String(entry?.content_base64 || ''), 'base64');
    if (bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) throw new WorkspaceError(`execution.files[${index}] has invalid bytes.`);
    const expected = entry?.sha256 ? digest(entry.sha256, `execution.files[${index}].sha256`) : sha256(bytes);
    if (sha256(bytes) !== expected) throw new WorkspaceError(`execution.files[${index}] digest does not match content.`);
    return Object.freeze({ path: filename, content_base64: bytes.toString('base64'), sha256: expected, size_bytes: bytes.length });
  });
  if (new Set(files.map(entry => entry.path)).size !== files.length) throw new WorkspaceError('Execution file paths must be unique.');
  return Object.freeze({
    schema: 'archie-hybrid-materialize-files/v1',
    request: text(value.request, 'execution.request'),
    files: Object.freeze(files)
  });
}

function normalizeOffer(value) {
  const allowedPaths = uniqueStrings(value.allowed_paths, 'allowed_paths', { min: 1 }).map((entry, index) => {
    const normalized = entry.endsWith('/**') ? `${relativeFile(entry.slice(0, -3), `allowed_paths[${index}]`)}/**` : relativeFile(entry, `allowed_paths[${index}]`);
    if (normalized === '.archie-runner/**' || normalized.startsWith('.archie-runner/')) throw new WorkspaceAuthorityError('The runner control directory cannot be inside the write fence.');
    return normalized;
  });
  const capabilities = uniqueStrings(value.required_capabilities, 'required_capabilities', { min: 1 });
  for (const capability of capabilities) {
    if (!ALLOWED_CAPABILITIES.includes(capability) || FORBIDDEN_CAPABILITY_PATTERN.test(capability)) throw new WorkspaceAuthorityError(`Offer capability is not admitted: ${capability}.`);
  }
  return Object.freeze({
    schema: ARCHIE_HYBRID_OFFER_SCHEMA,
    workspace_id: id(value.workspace_id, 'workspace_id'),
    task_id: id(value.task_id, 'task_id'),
    title: text(value.title, 'title', { max: 200 }),
    required_protocol_version: text(value.required_protocol_version || ARCHIE_HYBRID_PROTOCOL_VERSION, 'required_protocol_version', { max: 40 }),
    required_capabilities: Object.freeze(capabilities.sort()),
    minimum_resources: Object.freeze({
      memory_bytes: integer(value.minimum_resources?.memory_bytes ?? 1, 'minimum_resources.memory_bytes', { min: 1 }),
      disk_free_bytes: integer(value.minimum_resources?.disk_free_bytes ?? 1, 'minimum_resources.disk_free_bytes', { min: 1 })
    }),
    allowed_paths: Object.freeze(allowedPaths),
    execution: normalizeExecution(value.execution, allowedPaths),
    artifact_admission: normalizeArtifactAdmission(value.artifact_admission, allowedPaths),
    lease_ttl_ms: integer(value.lease_ttl_ms ?? 3_600_000, 'lease_ttl_ms', { min: 10_000, max: 86_400_000 }),
    authority: Object.freeze({
      contact: false,
      spend: false,
      deploy: false,
      publish: false,
      network: false,
      credential_transfer: false,
      write_scope: 'allowed_paths_only'
    })
  });
}

export function hybridEventDigest(event) {
  const unsigned = { ...event };
  delete unsigned.digest;
  return sha256(stableJSONStringify(unsigned));
}

function normalizeRunnerEvent(value, lease) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== ARCHIE_HYBRID_EVENT_SCHEMA) {
    throw new WorkspaceError(`Runner event must use ${ARCHIE_HYBRID_EVENT_SCHEMA}.`);
  }
  const event = {
    schema: ARCHIE_HYBRID_EVENT_SCHEMA,
    lease_id: id(value.lease_id, 'event.lease_id'),
    sequence: integer(value.sequence, 'event.sequence', { min: 1 }),
    kind: text(value.kind || 'progress', 'event.kind', { max: 80 }),
    summary: text(value.summary, 'event.summary', { max: 4_000 }),
    occurred_at: new Date(value.occurred_at).toISOString(),
    previous_digest: value.previous_digest === null ? null : digest(value.previous_digest, 'event.previous_digest'),
    payload_digest: digest(value.payload_digest, 'event.payload_digest')
  };
  event.digest = digest(value.digest, 'event.digest');
  if (event.lease_id !== lease.lease_id) throw new WorkspaceAuthorityError('Runner event belongs to another lease.');
  if (event.sequence !== lease.event_sequence + 1) throw new WorkspaceConflictError('Runner event sequence is not the next fenced sequence.');
  if (event.previous_digest !== lease.event_head) throw new WorkspaceConflictError('Runner event chain head does not match the lease.');
  if (hybridEventDigest(event) !== event.digest) throw new WorkspaceError('Runner event digest is invalid.');
  return Object.freeze(event);
}

function defaultRegistry() {
  return { schema: REGISTRY_SCHEMA, enrollments: {}, runners: {}, offers: {}, leases: {} };
}

export class HybridRegistry {
  constructor(root, { clock = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.filename = path.join(this.root, 'registry.json');
    this.clock = clock;
    this.tail = Promise.resolve();
  }

  async read() {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (value.schema !== REGISTRY_SCHEMA) throw new WorkspaceError('Hybrid registry schema is invalid.');
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultRegistry();
      throw error;
    }
  }

  async write(value) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filename);
    await fs.chmod(this.filename, 0o600).catch(() => {});
  }

  transaction(mutator) {
    const operation = this.tail.then(async () => {
      const registry = await this.read();
      const result = await mutator(registry);
      await this.write(registry);
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}

function bearer(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function fence(request) {
  const value = request.headers['x-archie-fence'];
  return Array.isArray(value) ? value[0] : String(value || '');
}

async function readJson(request) {
  const bytes = await readBytes(request, MAX_JSON_BODY);
  try { return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
  catch { throw new WorkspaceError('Request body must be valid JSON.'); }
}

async function readBytes(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WorkspaceError('Request body exceeds the admitted byte limit.', { code: 'body_too_large', status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(body);
}

function publicLease(lease, fenceToken = null) {
  return Object.freeze({
    schema: ARCHIE_HYBRID_LEASE_SCHEMA,
    lease_id: lease.lease_id,
    offer_id: lease.offer_id,
    runner_id: lease.runner_id,
    workspace_id: lease.workspace_id,
    task_id: lease.task_id,
    run_id: lease.run_id,
    status: lease.status,
    claimed_at: lease.claimed_at,
    expires_at: lease.expires_at,
    event_sequence: lease.event_sequence,
    event_head: lease.event_head,
    uploaded_artifacts: clone(lease.uploaded_artifacts),
    fence_token: fenceToken,
    fence_token_disclosed_once: Boolean(fenceToken)
  });
}

function runnerMatches(runner, offer) {
  const advertisement = runner.advertisement;
  return advertisement.protocol_version === offer.required_protocol_version
    && offer.required_capabilities.every(capability => advertisement.capabilities.includes(capability))
    && advertisement.resources.memory_bytes >= offer.minimum_resources.memory_bytes
    && advertisement.resources.disk_free_bytes >= offer.minimum_resources.disk_free_bytes
    && advertisement.privacy.inbound_access === false
    && advertisement.privacy.filesystem_scope === 'bounded_root'
    && advertisement.privacy.artifact_upload === 'explicit_only'
    && advertisement.privacy.credentials === 'local_only';
}

export function createHybridService({ engine, root, clock = () => Date.now(), registry = null } = {}) {
  if (!engine) throw new WorkspaceError('Hybrid service requires the Archie workspace engine.');
  const store = registry || new HybridRegistry(root, { clock });

  async function authenticateRunner(request, registryState) {
    const raw = bearer(request);
    if (!raw) throw new WorkspaceAuthorityError('Runner bearer authentication is required.');
    const tokenSha = tokenDigest(raw);
    const runner = Object.values(registryState.runners).find(entry => secureEqual(entry.token_digest, tokenSha));
    if (!runner || runner.revoked_at || Date.parse(runner.expires_at) <= clock()) throw new WorkspaceAuthorityError('Runner identity is invalid or expired.');
    return runner;
  }

  function authenticateFence(request, lease) {
    const raw = fence(request);
    if (!raw || !secureEqual(lease.fence_digest, tokenDigest(raw))) throw new WorkspaceAuthorityError('The lease fence token is missing or invalid.');
  }

  async function createEnrollment(input) {
    const expiresInSeconds = integer(input.expires_in_seconds ?? 900, 'expires_in_seconds', { min: 60, max: 86_400 });
    const enrollmentToken = token();
    return store.transaction(async registryState => {
      const enrollmentId = `enrollment_${crypto.randomBytes(12).toString('hex')}`;
      registryState.enrollments[enrollmentId] = {
        enrollment_id: enrollmentId,
        token_digest: tokenDigest(enrollmentToken),
        created_at: nowIso(clock),
        expires_at: new Date(clock() + expiresInSeconds * 1000).toISOString(),
        used_at: null,
        required_protocol_version: text(input.required_protocol_version || ARCHIE_HYBRID_PROTOCOL_VERSION, 'required_protocol_version', { max: 40 }),
        required_capabilities: uniqueStrings(input.required_capabilities || ALLOWED_CAPABILITIES, 'required_capabilities', { min: 1 }).sort()
      };
      return Object.freeze({
        schema: 'archie-hybrid-enrollment-issued/v1',
        enrollment_id: enrollmentId,
        enrollment_token: enrollmentToken,
        token_disclosed_once: true,
        expires_at: registryState.enrollments[enrollmentId].expires_at,
        required_protocol_version: registryState.enrollments[enrollmentId].required_protocol_version,
        required_capabilities: registryState.enrollments[enrollmentId].required_capabilities
      });
    });
  }

  async function enroll(input) {
    const rawEnrollmentToken = text(input.enrollment_token, 'enrollment_token', { min: 24, max: 256 });
    const advertisement = normalizeAdvertisement(input.advertisement);
    const runnerToken = token();
    return store.transaction(async registryState => {
      const enrollmentSha = tokenDigest(rawEnrollmentToken);
      const enrollment = Object.values(registryState.enrollments).find(entry => secureEqual(entry.token_digest, enrollmentSha));
      if (!enrollment || enrollment.used_at || Date.parse(enrollment.expires_at) <= clock()) throw new WorkspaceAuthorityError('Enrollment token is invalid, used, or expired.');
      if (advertisement.protocol_version !== enrollment.required_protocol_version) throw new WorkspaceAuthorityError('Runner protocol version is not admitted by the enrollment.');
      if (!enrollment.required_capabilities.every(capability => advertisement.capabilities.includes(capability))) {
        throw new WorkspaceAuthorityError('Runner advertisement is missing an enrollment capability.');
      }
      const runnerId = `runner_${crypto.randomBytes(12).toString('hex')}`;
      const expiresAt = new Date(clock() + 30 * 24 * 60 * 60 * 1000).toISOString();
      enrollment.used_at = nowIso(clock);
      registryState.runners[runnerId] = {
        runner_id: runnerId,
        token_digest: tokenDigest(runnerToken),
        enrolled_at: enrollment.used_at,
        expires_at: expiresAt,
        revoked_at: null,
        current_lease_id: null,
        advertisement
      };
      return Object.freeze({
        schema: 'archie-hybrid-runner-identity/v1',
        runner_id: runnerId,
        runner_token: runnerToken,
        token_disclosed_once: true,
        expires_at: expiresAt,
        advertisement
      });
    });
  }

  async function createOffer(input) {
    const offer = normalizeOffer(input);
    const state = await engine.inspect(offer.workspace_id, { principalId: 'owner_local' });
    const task = state.tasks[offer.task_id];
    if (!task) throw new WorkspaceError(`Task ${offer.task_id} was not found.`, { code: 'not_found', status: 404 });
    if (task.status !== 'open') throw new WorkspaceConflictError('Hybrid work can be offered only for an open task.');
    return store.transaction(async registryState => {
      if (Object.values(registryState.offers).some(entry => entry.workspace_id === offer.workspace_id && entry.task_id === offer.task_id && ['pending', 'leased'].includes(entry.status))) {
        throw new WorkspaceConflictError('This task already has an active hybrid offer.');
      }
      const offerId = `offer_${crypto.randomBytes(12).toString('hex')}`;
      const record = { ...offer, offer_id: offerId, status: 'pending', created_at: nowIso(clock), lease_id: null };
      registryState.offers[offerId] = record;
      return Object.freeze({ schema: ARCHIE_HYBRID_OFFER_SCHEMA, ...clone(record) });
    });
  }

  async function claim(request) {
    const fenceToken = token();
    return store.transaction(async registryState => {
      const runner = await authenticateRunner(request, registryState);
      if (runner.current_lease_id) {
        const current = registryState.leases[runner.current_lease_id];
        if (current && current.status === 'active' && Date.parse(current.expires_at) > clock()) return { lease: publicLease(current), assignment: clone(registryState.offers[current.offer_id]), resumed: true };
        runner.current_lease_id = null;
      }
      const offer = Object.values(registryState.offers)
        .filter(entry => entry.status === 'pending' && runnerMatches(runner, entry))
        .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
      if (!offer) return null;
      const leaseId = `lease_${crypto.randomBytes(12).toString('hex')}`;
      const runId = `run_${crypto.randomBytes(12).toString('hex')}`;
      const agentId = runner.runner_id;
      const workspace = await engine.inspect(offer.workspace_id, { principalId: 'owner_local' });
      if (!workspace.agents[agentId]) {
        await engine.execute(offer.workspace_id, 'owner_local', 'agent.register', {
          agent_id: agentId,
          label: `Outbound hybrid runner ${runner.runner_id.slice(-8)}`,
          kind: 'service',
          provider: 'archie-hybrid-outbound/v1'
        });
      }
      await engine.execute(offer.workspace_id, 'owner_local', 'grant.issue', {
        grant_id: `grant_${leaseId}`,
        principal_id: agentId,
        task_id: offer.task_id,
        capabilities: ['read', 'write', 'run'],
        expires_at: new Date(clock() + offer.lease_ttl_ms).toISOString()
      });
      await engine.execute(offer.workspace_id, agentId, 'lease.claim', { task_id: offer.task_id, lease_id: leaseId, ttl_ms: offer.lease_ttl_ms });
      await engine.execute(offer.workspace_id, agentId, 'run.start', { task_id: offer.task_id, run_id: runId });
      const record = {
        schema: ARCHIE_HYBRID_LEASE_SCHEMA,
        lease_id: leaseId,
        offer_id: offer.offer_id,
        runner_id: runner.runner_id,
        workspace_id: offer.workspace_id,
        task_id: offer.task_id,
        run_id: runId,
        fence_digest: tokenDigest(fenceToken),
        claimed_at: nowIso(clock),
        expires_at: new Date(clock() + offer.lease_ttl_ms).toISOString(),
        status: 'active',
        event_sequence: 0,
        event_head: null,
        uploaded_artifacts: {},
        terminal_receipt_digest: null
      };
      registryState.leases[leaseId] = record;
      runner.current_lease_id = leaseId;
      offer.status = 'leased';
      offer.lease_id = leaseId;
      return { lease: publicLease(record, fenceToken), assignment: clone(offer), resumed: false };
    });
  }

  async function withLease(request, leaseId, operation) {
    return store.transaction(async registryState => {
      const runner = await authenticateRunner(request, registryState);
      const lease = registryState.leases[id(leaseId, 'lease_id')];
      if (!lease || lease.runner_id !== runner.runner_id) throw new WorkspaceAuthorityError('Lease is not owned by this runner.');
      authenticateFence(request, lease);
      if (lease.status !== 'active') throw new WorkspaceConflictError(`Lease is already ${lease.status}.`);
      if (Date.parse(lease.expires_at) <= clock()) throw new WorkspaceConflictError('Lease has expired and can no longer mutate the workspace.');
      return operation({ registryState, runner, lease, offer: registryState.offers[lease.offer_id] });
    });
  }

  async function appendEvent(request, leaseId, input) {
    return withLease(request, leaseId, async ({ lease }) => {
      const event = normalizeRunnerEvent(input, lease);
      await engine.execute(lease.workspace_id, lease.runner_id, 'run.append_event', {
        run_id: lease.run_id,
        kind: `hybrid:${event.kind}`,
        summary: `${event.summary} [protocol ${event.digest}]`
      });
      lease.event_sequence = event.sequence;
      lease.event_head = event.digest;
      return Object.freeze({ schema: 'archie-hybrid-event-ack/v1', lease_id: lease.lease_id, sequence: event.sequence, event_head: event.digest });
    });
  }

  async function uploadArtifact(request, leaseId, artifactId) {
    return withLease(request, leaseId, async ({ lease, offer }) => {
      const admitted = offer.artifact_admission.find(entry => entry.artifact_id === artifactId);
      if (!admitted) throw new WorkspaceAuthorityError('Artifact is not explicitly admitted by this lease.');
      if (lease.uploaded_artifacts[artifactId]) return Object.freeze(clone(lease.uploaded_artifacts[artifactId]));
      const bytes = await readBytes(request, admitted.max_bytes);
      if (!bytes.length) throw new WorkspaceError('Artifact upload is empty.');
      const actualDigest = sha256(bytes);
      if (admitted.sha256 && actualDigest !== admitted.sha256) throw new WorkspaceError('Artifact upload digest does not match the admission contract.');
      const workspaceArtifactId = `artifact_${lease.lease_id.slice(6)}_${artifactId}`.slice(0, 128);
      const result = await engine.execute(lease.workspace_id, lease.runner_id, 'artifact.record', {
        run_id: lease.run_id,
        artifact_id: workspaceArtifactId,
        name: admitted.name,
        media_type: admitted.media_type,
        content_base64: bytes.toString('base64')
      });
      const recorded = result.state.artifacts[workspaceArtifactId];
      lease.uploaded_artifacts[artifactId] = {
        artifact_id: artifactId,
        workspace_artifact_id: workspaceArtifactId,
        sha256: recorded.sha256,
        size_bytes: recorded.size_bytes,
        uploaded_at: nowIso(clock)
      };
      return Object.freeze(clone(lease.uploaded_artifacts[artifactId]));
    });
  }

  async function finish(request, leaseId, input, { failed = false } = {}) {
    return withLease(request, leaseId, async ({ registryState, runner, lease, offer }) => {
      const receiptSchema = failed ? ARCHIE_HYBRID_FAILURE_SCHEMA : ARCHIE_HYBRID_TERMINAL_SCHEMA;
      if (!input || input.schema !== receiptSchema) throw new WorkspaceError(`Terminal receipt must use ${receiptSchema}.`);
      if (!failed) {
        const missing = offer.artifact_admission.filter(entry => entry.required && !lease.uploaded_artifacts[entry.artifact_id]);
        if (missing.length) throw new WorkspaceConflictError(`Required artifacts are missing: ${missing.map(entry => entry.artifact_id).join(', ')}.`);
      }
      const receipt = {
        schema: receiptSchema,
        lease_id: lease.lease_id,
        runner_id: runner.runner_id,
        workspace_id: lease.workspace_id,
        task_id: lease.task_id,
        run_id: lease.run_id,
        status: failed ? 'failed' : 'completed',
        summary: text(input.summary, 'terminal summary', { max: 8_000 }),
        event_sequence: lease.event_sequence,
        event_head: lease.event_head,
        uploaded_artifacts: clone(lease.uploaded_artifacts),
        maker_receipt: input.maker_receipt && typeof input.maker_receipt === 'object' ? clone(input.maker_receipt) : null,
        failure: failed && input.failure && typeof input.failure === 'object' ? {
          phase: text(input.failure.phase || 'unknown', 'failure.phase', { max: 80 }),
          error_class: text(input.failure.error_class || 'Error', 'failure.error_class', { max: 160 }),
          message: text(input.failure.message || 'Hybrid runner failed.', 'failure.message', { max: 4_000 })
        } : null,
        completed_at: nowIso(clock),
        authority: offer.authority
      };
      receipt.receipt_digest = sha256(stableJSONStringify(receipt));
      const terminalArtifactId = `${failed ? 'artifact_failure_' : 'artifact_terminal_'}${lease.lease_id.slice(6)}`.slice(0, 128);
      await engine.execute(lease.workspace_id, lease.runner_id, 'artifact.record', {
        run_id: lease.run_id,
        artifact_id: terminalArtifactId,
        name: failed ? 'hybrid-failure-receipt.json' : 'hybrid-terminal-receipt.json',
        media_type: 'application/json',
        content: `${JSON.stringify(receipt, null, 2)}\n`
      });
      await engine.execute(lease.workspace_id, lease.runner_id, 'run.complete', {
        run_id: lease.run_id,
        status: failed ? 'blocked' : 'completed',
        summary: receipt.summary
      });
      lease.status = failed ? 'failed' : 'completed';
      lease.terminal_receipt_digest = receipt.receipt_digest;
      runner.current_lease_id = null;
      offer.status = lease.status;
      return Object.freeze(receipt);
    });
  }

  async function status() {
    const value = await store.read();
    return Object.freeze({
      schema: 'archie-hybrid-status/v1',
      protocol_version: ARCHIE_HYBRID_PROTOCOL_VERSION,
      enrollment_count: Object.keys(value.enrollments).length,
      runner_count: Object.keys(value.runners).length,
      pending_offer_count: Object.values(value.offers).filter(entry => entry.status === 'pending').length,
      active_lease_count: Object.values(value.leases).filter(entry => entry.status === 'active').length,
      completed_lease_count: Object.values(value.leases).filter(entry => entry.status === 'completed').length,
      failed_lease_count: Object.values(value.leases).filter(entry => entry.status === 'failed').length,
      inbound_runner_access_required: false,
      artifact_upload_policy: 'explicit_only',
      authority: { contact: false, spend: false, deploy: false, publish: false, network: false, credential_transfer: false }
    });
  }

  async function handleFounder(request, response, pathname) {
    if (request.method === 'POST' && pathname === '/v1/hybrid/founder/enrollments') {
      jsonResponse(response, 201, await createEnrollment(await readJson(request)));
      return true;
    }
    if (request.method === 'POST' && pathname === '/v1/hybrid/founder/offers') {
      jsonResponse(response, 201, await createOffer(await readJson(request)));
      return true;
    }
    if (request.method === 'GET' && pathname === '/v1/hybrid/founder/status') {
      jsonResponse(response, 200, await status());
      return true;
    }
    return false;
  }

  async function handleRunner(request, response, pathname, parts) {
    if (request.method === 'POST' && pathname === '/v1/hybrid/runner/enroll') {
      jsonResponse(response, 201, await enroll(await readJson(request)));
      return true;
    }
    if (request.method === 'POST' && pathname === '/v1/hybrid/runner/claim') {
      const claimed = await claim(request);
      if (!claimed) {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      } else jsonResponse(response, 200, { schema: 'archie-hybrid-claim/v1', ...claimed });
      return true;
    }
    if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'runner' && parts[3] === 'leases' && parts[4]) {
      const leaseId = parts[4];
      if (request.method === 'GET' && parts.length === 5) {
        const lease = await withLease(request, leaseId, async ({ lease, offer }) => ({ lease: publicLease(lease), assignment: clone(offer), resumed: true }));
        jsonResponse(response, 200, { schema: 'archie-hybrid-claim/v1', ...lease });
        return true;
      }
      if (request.method === 'POST' && parts[5] === 'events' && parts.length === 6) {
        jsonResponse(response, 200, await appendEvent(request, leaseId, await readJson(request)));
        return true;
      }
      if (request.method === 'PUT' && parts[5] === 'artifacts' && parts[6] && parts.length === 7) {
        jsonResponse(response, 201, await uploadArtifact(request, leaseId, id(parts[6], 'artifact_id')));
        return true;
      }
      if (request.method === 'POST' && parts[5] === 'complete' && parts.length === 6) {
        jsonResponse(response, 200, await finish(request, leaseId, await readJson(request)));
        return true;
      }
      if (request.method === 'POST' && parts[5] === 'fail' && parts.length === 6) {
        jsonResponse(response, 200, await finish(request, leaseId, await readJson(request), { failed: true }));
        return true;
      }
    }
    return false;
  }

  return Object.freeze({
    schema: ARCHIE_HYBRID_PROTOCOL_SCHEMA,
    registry: store,
    createEnrollment,
    enroll,
    createOffer,
    claim,
    appendEvent,
    uploadArtifact,
    finish,
    status,
    handleFounder,
    handleRunner,
    descriptor: Object.freeze({
      schema: ARCHIE_HYBRID_PROTOCOL_SCHEMA,
      protocol_version: ARCHIE_HYBRID_PROTOCOL_VERSION,
      enrollment: 'expiring-single-use-token',
      runner_identity: 'expiring-bearer-token-digest-at-rest',
      lease_fencing: 'single-runner-single-task-random-fence-token',
      event_stream: 'sequence-and-digest-bound',
      artifact_upload: 'explicit-admission-only',
      inbound_runner_access_required: false,
      authority: { contact: false, spend: false, deploy: false, publish: false, network: false, credential_transfer: false }
    })
  });
}
