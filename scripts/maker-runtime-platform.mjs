#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createMakerControlPlane } from './maker-control-plane.mjs';
import { createModelRouter } from './maker-model-router.mjs';
import { createWorkerFleet } from './maker-worker-fleet.mjs';
import { createPluginRegistry } from './maker-plugin-registry.mjs';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const unique = (values, limit = 300) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 500)).filter(Boolean))].slice(0, limit);
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|endpoint|runner[_-]?secret)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|https?:\/\/[^\s"']+(?:token|secret|key)=[^\s"']+)\b/gi;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export const platformDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function redactPlatformSecrets(value, depth = 0) {
  if (depth > 14) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactPlatformSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [
      clean(key, 300),
      SECRET_KEY.test(key) ? '[redacted]' : redactPlatformSecrets(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'), 20000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

export class MakerRuntimePlatformError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'MakerRuntimePlatformError';
    this.code = code;
    this.status = status;
    this.detail = redactPlatformSecrets(detail);
  }
}

function normalizeAuthority(input = {}) {
  const capabilities = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : {};
  return Object.freeze({
    branch: input.branch !== false,
    draft_pr: input.draft_pr !== false,
    merge: input.merge === true,
    deploy: input.deploy === true,
    settings: input.settings === true,
    capabilities: Object.freeze(Object.fromEntries(Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [clean(key, 100), clean(value, 100)])))
  });
}

export function normalizePlatformRequest(input = {}) {
  const target_repository = clean(input.target_repository || input.repository, 500);
  const control_repository = clean(input.control_repository || target_repository, 500);
  const head_repository = clean(input.head_repository || target_repository, 500);
  for (const [name, value] of Object.entries({ control_repository, target_repository, head_repository })) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new MakerRuntimePlatformError('invalid_repository', `${name} must be owner/name`);
  }
  const request = clean(input.request, 12000);
  if (!request) throw new MakerRuntimePlatformError('missing_request', 'request is required');
  return Object.freeze({
    schema: 'sideways-maker-runtime-platform-request/v1',
    control_repository,
    target_repository,
    head_repository,
    repository: target_repository,
    base_revision: clean(input.base_revision || input.base || 'main', 200),
    mode: clean(input.mode || 'build', 40).toLowerCase(),
    backend: clean(input.backend || 'auto', 100),
    request,
    protect: clean(input.protect, 12000),
    proof: clean(input.proof, 12000),
    device_requirement: clean(input.device_requirement, 300),
    priority: Math.max(0, Math.min(100, Number(input.priority ?? 50))),
    budgets: Object.freeze(redactPlatformSecrets(input.budgets || {})),
    authority: normalizeAuthority(input.authority),
    runtime_requirements: Object.freeze(redactPlatformSecrets(input.runtime_requirements || {})),
    model_task: Object.freeze(redactPlatformSecrets(input.model_task || {})),
    model_state: Object.freeze(redactPlatformSecrets(input.model_state || {})),
    fleet_requirements: Object.freeze(redactPlatformSecrets(input.fleet_requirements || {})),
    required_plugin_capabilities: unique(input.required_plugin_capabilities || input.runtime_requirements?.plugin_capabilities),
    idempotency_key: clean(input.idempotency_key, 300)
  });
}

function mapError(error, fallback = 'platform_failed') {
  const code = clean(error?.code || fallback, 100);
  const aliases = {
    no_provider: 'no_admitted_provider',
    fallback_exhausted: 'provider_fallback_exhausted',
    capacity_unavailable: 'no_compatible_fleet_capacity',
    capability_mismatch: 'no_compatible_fleet_capacity',
    unhealthy_capacity: 'no_compatible_fleet_capacity',
    unverified_capacity: 'unverified_worker',
    plugin_denied: 'plugin_admission_failure',
    human_approval_required: 'approval_gated_authority',
    plugin_runtime_unavailable: 'unavailable_adapter',
    fencing_mismatch: 'stale_lease_or_fencing_token',
    lease_expired: 'stale_lease_or_fencing_token',
    lease_mismatch: 'stale_lease_or_fencing_token'
  };
  return aliases[code] || code;
}

function pluginResolution(snapshot, requestedCapabilities, authority) {
  const enabled = new Set(snapshot.enabled || []);
  const admitted = Array.isArray(snapshot.admitted) ? snapshot.admitted : [];
  const available = new Map();
  for (const record of admitted) {
    if (!enabled.has(record.plugin_id) || record.state !== 'enabled') continue;
    for (const capability of record.manifest?.declared_capabilities || []) {
      if (!available.has(capability)) available.set(capability, []);
      available.get(capability).push(record);
    }
  }
  const missing = requestedCapabilities.filter(capability => !available.has(capability));
  if (missing.length) throw new MakerRuntimePlatformError('missing_plugin_capability', 'required plugin capability is unavailable', 503, { missing });
  const approval = Object.entries(authority.capabilities).filter(([, level]) => level === 'approval_required').map(([capability]) => capability);
  if (approval.length) throw new MakerRuntimePlatformError('approval_gated_authority', 'requested authority requires operator approval', 403, { capabilities: approval });
  const selected = requestedCapabilities.map(capability => {
    const record = available.get(capability).sort((a, b) => a.plugin_id.localeCompare(b.plugin_id))[0];
    return Object.freeze({ capability, plugin_id: record.plugin_id, version: record.manifest.version, admission: record.admission, manifest_digest: record.manifest.manifest_digest });
  });
  return Object.freeze({ schema: 'sideways-maker-platform-plugin-resolution/v1', selected, snapshot_digest: snapshot.receipt_digest || platformDigest(snapshot) });
}

function runtimeProfile(request, route, placement, plugins, clock) {
  const worker = placement.worker || {};
  const authority = Object.fromEntries(Object.entries(request.authority.capabilities).map(([key, value]) => [key, value]));
  return Object.freeze(redactPlatformSecrets({
    schema: 'sideways-maker-runtime-profile/v1',
    runtime_id: `fleet:${placement.worker_id}`,
    display_name: worker.identity?.subject || placement.worker_id,
    status: 'healthy',
    intelligence: {
      selection: 'adaptive',
      engine_label: route.provider?.engine_label || route.provider?.display_name || route.provider?.id,
      architecture: route.provider?.kind === 'native_checkpoint' ? 'native' : 'remote',
      admission: route.provider?.admission?.admitted === false ? 'unverified' : 'verified',
      capabilities: unique([...(request.runtime_requirements.capabilities || []), ...request.required_plugin_capabilities])
    },
    endpoint: {
      ownership: request.runtime_requirements.ownership || 'project',
      transport: worker.mode === 'local' || worker.mode === 'in_process' ? 'local' : 'remote',
      locality: worker.placement?.locality || 'unknown',
      capacity: request.runtime_requirements.dedicated_capacity ? 'dedicated' : 'shared',
      throttling: 'bounded',
      label: `${worker.mode || 'worker'} fleet adapter`
    },
    planning: { strategy: 'adaptive', scheduler: 'priority', parallelism: 1, speculation: false, recovery: 'lease' },
    execution: {
      role: route.provider?.role || request.model_task.role || 'implementer',
      modes: unique(request.runtime_requirements.execution_roles || ['implementer']),
      transport: 'queue', workspace: 'isolated', verification: 'continuous', checkpointing: 'enabled', recovery: 'lease'
    },
    authority: { capabilities: authority },
    presentation: { headline: 'Maker runtime reserved', activity: 'Admitted intelligence and verified compute are active', tone: 'technical', visible: true },
    component_receipts: {
      model_route_digest: route.receipt_digest,
      placement_digest: placement.receipt_digest,
      plugin_snapshot_digest: plugins.snapshot_digest
    },
    observed_at: new Date(clock()).toISOString()
  }));
}

function receipt({ request, route, placement, pluginState, controlJob, dispatch, presentation, controlReceipt, outcome, at }) {
  const value = {
    schema: 'sideways-maker-runtime-platform-receipt/v1',
    outcome,
    request: redactPlatformSecrets(request),
    links: {
      model_route: route.receipt_digest,
      fleet_placement: placement.receipt_digest,
      plugin_state: pluginState.snapshot_digest,
      control_job: controlJob.request_digest || platformDigest(controlJob),
      dispatch: dispatch.receipt_digest || platformDigest(dispatch),
      public_presentation: platformDigest(presentation)
    },
    components: redactPlatformSecrets({ model_route: route, fleet_placement: placement, plugin_state: pluginState, control_job: controlJob, dispatch_receipt: dispatch, control_export: controlReceipt }),
    public_presentation: redactPlatformSecrets(presentation),
    finished_at: at
  };
  value.integrity_digest = platformDigest({ ...value, integrity_digest: undefined });
  return Object.freeze(value);
}

export function createMakerRuntimePlatform({
  controlPlane,
  modelRouter,
  workerFleet,
  pluginRegistry,
  control = {},
  models = {},
  fleet = {},
  plugins = {},
  clock = Date.now,
  id = randomUUID
} = {}) {
  const controlApi = controlPlane || createMakerControlPlane({ ...control, clock, id });
  const modelApi = modelRouter || createModelRouter({ ...models, clock, id });
  const fleetApi = workerFleet || createWorkerFleet({ ...fleet, clock, id });
  const pluginApi = pluginRegistry || createPluginRegistry({ ...plugins, clock, id });

  async function run(input = {}) {
    const request = normalizePlatformRequest(input);
    let job;
    let route;
    let placement;
    let pluginState;
    let claimed;
    let dispatch;
    let fleetClosed = false;
    try {
      job = await controlApi.submit(request);
      route = await modelApi.execute({ type: 'coding', id: `platform:${job.id}`, max_cost_usd: request.budgets.cost_usd, ...request.model_task }, request.model_state, { task_budget: request.budgets });
      const fleetTask = {
        id: job.id,
        repository: request.target_repository,
        backend: request.backend,
        priority: request.priority,
        kind: request.mode,
        requirements: { verified_identity: true, ...request.fleet_requirements, providers: unique([...(request.fleet_requirements.providers || []), route.provider.id]) },
        retry: { allowed: request.runtime_requirements.recoverable !== false, max_attempts: 2, lost_worker: 'retry' }
      };
      await fleetApi.enqueue(fleetTask);
      placement = await fleetApi.place(fleetTask);
      if (!['attested', 'verified'].includes(placement.worker?.identity?.state)) throw new MakerRuntimePlatformError('unverified_worker', 'selected worker identity is not verified', 503, { worker_id: placement.worker_id });
      const snapshot = await pluginApi.snapshot();
      pluginState = pluginResolution(snapshot, request.required_plugin_capabilities, request.authority);
      const profile = runtimeProfile(request, route, placement, pluginState, clock);
      claimed = await controlApi.claim({ worker_id: placement.worker_id, repository: request.target_repository, runtime: profile });
      if (!claimed || claimed.id !== job.id) throw new MakerRuntimePlatformError('control_claim_failed', 'control-plane job could not be claimed by selected worker', 409, { expected_job_id: job.id, claimed_job_id: claimed?.id });
      dispatch = await fleetApi.dispatch(placement, redactPlatformSecrets({ job: claimed, runtime_profile: profile, model_route: route, plugins: pluginState.selected }));
      dispatch = Object.freeze({ ...redactPlatformSecrets(dispatch), receipt_digest: dispatch.receipt_digest || platformDigest(dispatch) });
      if (!dispatch.ok) throw new MakerRuntimePlatformError(mapError(dispatch.error, 'dispatch_failure'), dispatch.error?.message || 'fleet dispatch failed', 502, { dispatch });
      const output = dispatch.output || {};
      if (output.cancelled === true || output.state === 'cancelled') {
        await controlApi.cancel(job.id, output.reason || 'worker cancelled');
        await fleetApi.cancel(job.id, output.reason || 'worker cancelled');
        fleetClosed = true;
      } else if (output.recoverable === true || output.state === 'interrupted') {
        await controlApi.fail(job.id, claimed.lease.token, { code: 'worker_interrupted', message: output.message || 'worker interrupted', recoverable: true, references: output.references });
        await fleetApi.cancel(job.id, output.message || 'recoverable worker interruption');
        fleetClosed = true;
      } else {
        await controlApi.complete(job.id, claimed.lease.token, output.result || output);
        await fleetApi.finish(job.id, placement.lease.fencing_token, output.result || output);
        fleetClosed = true;
      }
      const presentation = await controlApi.view(job.id);
      const controlReceipt = await controlApi.exportReceipt(job.id);
      const outcome = presentation.state || (output.recoverable ? 'failed' : 'completed');
      return receipt({ request, route, placement, pluginState, controlJob: claimed, dispatch, presentation, controlReceipt, outcome, at: new Date(clock()).toISOString() });
    } catch (error) {
      const code = mapError(error);
      if (job && claimed?.lease?.token) {
        try { await controlApi.fail(job.id, claimed.lease.token, { code, message: error.message, recoverable: code === 'recoverable_worker_interruption' }); } catch {}
      }
      if (job && placement && !fleetClosed) {
        try { await fleetApi.cancel(job.id, error.message); } catch {}
      }
      throw new MakerRuntimePlatformError(code, error.message || 'runtime platform failed', error.status || 500, { cause: error.detail, job_id: job?.id, route, placement, plugin_state: pluginState, dispatch });
    }
  }

  return Object.freeze({ run, submit: run, control: controlApi, models: modelApi, fleet: fleetApi, plugins: pluginApi });
}
