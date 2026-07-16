#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const unique = (values, limit = 300) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 300)).filter(Boolean))].slice(0, limit);
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|endpoint|runner[_-]?secret)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;

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
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'), 50000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

export class MakerRuntimePlatformError extends Error {
  constructor(code, message, status = 400, detail = {}, recoverable = false) {
    super(message);
    this.name = 'MakerRuntimePlatformError';
    this.code = code;
    this.status = status;
    this.detail = redactPlatformSecrets(detail);
    this.recoverable = recoverable;
  }
}

const KIND_AUTHORITY = Object.freeze({
  scm: { git: 'manage' },
  issue_review: { issues: 'manage', pull_requests: 'manage' },
  ci: { ci: 'manage' },
  artifact_store: { artifacts: 'manage' },
  deployment: { deployment: 'approval_required' },
  model_provider: { models: 'execute' },
  repository_intelligence: { repository_intelligence: 'read' },
  editor: { filesystem: 'write' },
  tool_runtime: { terminal: 'execute' },
  language_framework: { terminal: 'execute' },
  evaluator: { evaluator: 'execute' }
});

function mergeAuthority(target, source) {
  const rank = Object.freeze({ none: 0, read: 1, reference_only: 1, write: 2, execute: 3, manage: 4, approval_required: 5 });
  for (const [capability, level] of Object.entries(source || {})) {
    const key = clean(capability, 100).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    const current = target[key] || 'none';
    target[key] = rank[level] >= rank[current] ? level : current;
  }
  return target;
}

export function derivePluginAuthority(snapshot, { required_capabilities = [], required_authority = [], approved_capabilities = [], builtin_authority = {} } = {}) {
  const enabled = new Set(snapshot?.enabled || []);
  const records = (snapshot?.admitted || []).filter(record => enabled.has(record.plugin_id) && record.state === 'enabled');
  const authority = mergeAuthority({}, builtin_authority);
  const capabilities = new Set();
  const plugins = [];
  for (const record of records) {
    const manifest = record.manifest;
    const privileged = manifest.permissions?.privileged === true || manifest.kind === 'deployment';
    for (const capability of manifest.declared_capabilities || []) {
      capabilities.add(capability);
      authority[capability] = privileged ? 'approval_required' : (authority[capability] || 'execute');
    }
    mergeAuthority(authority, KIND_AUTHORITY[manifest.kind]);
    if (manifest.permissions?.filesystem?.write?.length) mergeAuthority(authority, { filesystem: privileged ? 'approval_required' : 'write' });
    if (manifest.permissions?.commands?.length) mergeAuthority(authority, { terminal: privileged ? 'approval_required' : 'execute' });
    if (manifest.permissions?.network_hosts?.length) mergeAuthority(authority, { network: privileged ? 'approval_required' : 'execute' });
    if (manifest.permissions?.secret_references?.length) mergeAuthority(authority, { secrets: 'reference_only' });
    plugins.push({ id: manifest.id, version: manifest.version, kind: manifest.kind, capabilities: manifest.declared_capabilities, privileged });
  }
  for (const capability of required_capabilities) {
    if (!capabilities.has(capability)) {
      throw new MakerRuntimePlatformError('plugin_capability_missing', `required plugin capability ${capability} is not enabled`, 409, { capability });
    }
  }
  const approvals = new Set(approved_capabilities);
  for (const capability of Object.keys(authority)) {
    if (authority[capability] === 'approval_required' && approvals.has(capability)) authority[capability] = 'execute';
  }
  for (const capability of required_authority) {
    const level = authority[capability] || 'none';
    if (level === 'approval_required') {
      throw new MakerRuntimePlatformError('authority_approval_required', `authority ${capability} requires approval`, 403, { capability });
    }
    if (level === 'none') throw new MakerRuntimePlatformError('authority_missing', `authority ${capability} is unavailable`, 403, { capability });
  }
  return Object.freeze({ authority: Object.freeze(authority), capabilities: [...capabilities].sort(), plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)) });
}

function providerArchitecture(kind) {
  if (kind === 'native_checkpoint' || kind === 'ollama') return 'native';
  if (kind === 'configured') return 'unknown';
  return 'remote';
}
function endpointOwnership(mode) {
  if (['local', 'in_process', 'self_hosted'].includes(mode)) return 'user';
  if (mode === 'remote_http') return 'hybrid';
  return 'managed';
}
function endpointTransport(mode) {
  if (['local', 'in_process'].includes(mode)) return 'local';
  if (mode === 'self_hosted') return 'relay';
  return 'remote';
}
function endpointLocality(placement) {
  const privacy = placement.worker?.placement?.privacy;
  if (privacy === 'private') return 'private';
  return ['local', 'remote', 'hybrid'].includes(placement.worker?.placement?.locality) ? placement.worker.placement.locality : 'unknown';
}

export function buildRuntimeProfile({ route, placement, pluginAuthority, modelTask, planning = {}, clock = Date.now }) {
  const trueCapabilities = Object.entries(route.provider_descriptor?.capabilities || {})
    .filter(([, evidence]) => evidence?.value === true)
    .map(([name]) => name);
  const modelCapabilities = unique([...trueCapabilities, ...(modelTask.required || []), ...(modelTask.preferred || [])]);
  const mode = placement.worker.mode;
  return Object.freeze({
    runtime_id: `maker:${placement.worker_id}:${route.provider.id}`,
    display_name: 'Maker adaptive runtime',
    status: 'healthy',
    intelligence: {
      selection: 'adaptive',
      engine_label: route.provider.engine_label || route.provider.display_name || 'best available admitted engine',
      architecture: providerArchitecture(route.provider.kind),
      admission: route.provider.admission?.admitted === false ? 'unverified' : (route.provider.kind === 'native_checkpoint' ? 'verified' : 'configured'),
      capabilities: modelCapabilities
    },
    endpoint: {
      ownership: endpointOwnership(mode),
      transport: endpointTransport(mode),
      locality: endpointLocality(placement),
      capacity: placement.worker?.platform?.labels?.includes('burst') ? 'burst' : (placement.worker?.resources?.concurrency > 1 ? 'shared' : 'dedicated'),
      throttling: 'bounded',
      label: `${placement.worker.mode} Maker worker`
    },
    planning: {
      strategy: planning.strategy || 'adaptive',
      scheduler: planning.scheduler || 'adaptive',
      parallelism: planning.parallelism || 1,
      speculation: planning.speculation === true,
      recovery: planning.recovery || 'lease',
      confidence_threshold: planning.confidence_threshold ?? 0.8
    },
    execution: {
      role: modelTask.role || 'implementer',
      modes: unique([modelTask.role || 'implementer', 'planner', 'reviewer', 'verifier', 'repair']),
      transport: mode === 'self_hosted' ? 'relay' : mode === 'remote_http' ? 'direct' : mode === 'github_hosted' ? 'queue' : 'direct',
      workspace: placement.workspace?.isolation === 'container' ? 'container' : 'isolated',
      verification: 'continuous',
      checkpointing: 'enabled',
      recovery: 'journaled'
    },
    authority: { capabilities: pluginAuthority.authority },
    presentation: {
      headline: 'Maker is building your thing',
      activity: `Using admitted intelligence on ${placement.worker.mode.replaceAll('_', ' ')} compute`,
      tone: 'friendly',
      visible: true
    },
    observed_at: new Date(clock()).toISOString()
  });
}

function modelTypeForMode(mode) {
  return ({ build: 'coding', fix: 'debugging', explore: 'planning', audit: 'review' })[mode] || 'coding';
}
function recoverableCode(code) {
  return new Set(['fallback_exhausted', 'no_provider', 'capacity_unavailable', 'unverified_capacity', 'unhealthy_capacity', 'capability_mismatch', 'quota_exhausted', 'adapter_unavailable', 'dispatch_failed', 'plugin_timeout', 'lease_expired', 'control_claim_failed']).has(code);
}

export function createMakerRuntimePlatform({ control, modelRouter, fleet, plugins, clock = Date.now, id = randomUUID } = {}) {
  for (const [name, value, methods] of [
    ['control', control, ['submit', 'claim', 'complete', 'fail', 'cancel', 'view', 'heartbeat']],
    ['modelRouter', modelRouter, ['execute', 'providers']],
    ['fleet', fleet, ['enqueue', 'scheduleNext', 'dispatch', 'heartbeat', 'finish', 'cancel']],
    ['plugins', plugins, ['snapshot']]
  ]) {
    if (!value || methods.some(method => typeof value[method] !== 'function')) throw new MakerRuntimePlatformError('invalid_dependency', `${name} runtime contract is incomplete`);
  }

  function receipt(runId, state, context, error = null) {
    const value = {
      schema: 'sideways-maker-runtime-platform-receipt/v1',
      platform_run_id: runId,
      state,
      task: redactPlatformSecrets(context.controlRequest || null),
      components: {
        model_route: redactPlatformSecrets(context.route || null),
        fleet_placement: redactPlatformSecrets(context.placement || null),
        plugin_registry: redactPlatformSecrets(context.pluginSnapshot || null),
        plugin_authority: redactPlatformSecrets(context.pluginAuthority || null),
        runtime_profile: redactPlatformSecrets(context.runtimeProfile || null),
        control_job: redactPlatformSecrets(context.controlJob || null),
        dispatch: redactPlatformSecrets(context.dispatch || null),
        fleet_result: redactPlatformSecrets(context.fleetResult || null),
        presentation: redactPlatformSecrets(context.presentation || null)
      },
      error: error ? redactPlatformSecrets({ code: error.code || 'platform_failed', message: error.message, recoverable: error.recoverable === true, detail: error.detail || {} }) : null,
      finished_at: new Date(clock()).toISOString()
    };
    value.receipt_digest = platformDigest({ ...value, receipt_digest: undefined });
    return Object.freeze(value);
  }

  async function run(input = {}) {
    const runId = id();
    const context = {};
    let fleetTaskId = null;
    let controlClaim = null;
    try {
      const request = input.control_request || input.request || {};
      const targetRepository = clean(request.target_repository || request.repository, 500);
      const modelTask = {
        id: clean(input.model_task?.id || `${runId}:model`, 300),
        type: input.model_task?.type || modelTypeForMode(request.mode),
        role: input.model_task?.role,
        required: input.model_task?.required,
        preferred: input.model_task?.preferred,
        context_tokens: input.model_task?.context_tokens,
        output_tokens: input.model_task?.output_tokens,
        latency: input.model_task?.latency,
        privacy_minimum: input.model_task?.privacy_minimum,
        locality_preference: input.model_task?.locality_preference,
        region_preference: input.model_task?.region_preference,
        max_cost_usd: input.model_task?.max_cost_usd,
        input_tokens: input.model_task?.input_tokens,
        output_schema: input.model_task?.output_schema
      };
      context.route = await modelRouter.execute(modelTask, input.model_state || {}, input.model_options || {});
      const descriptor = modelRouter.providers().find(provider => provider.id === context.route.provider.id);
      context.route = Object.freeze({ ...context.route, provider_descriptor: descriptor ? redactPlatformSecrets(descriptor) : null });

      fleetTaskId = clean(input.fleet_task?.id || `${runId}:fleet`, 300);
      fleet.enqueue({
        id: fleetTaskId,
        repository: targetRepository,
        owner: input.fleet_task?.owner,
        backend: request.backend || 'auto',
        priority: request.priority ?? input.fleet_task?.priority ?? 50,
        kind: request.mode || 'build',
        requirements: input.fleet_task?.requirements || {},
        preferences: input.fleet_task?.preferences || {},
        retry: input.fleet_task?.retry || {},
        reservation: input.fleet_task?.reservation || 'normal',
        created_at: new Date(clock()).toISOString()
      });
      context.placement = fleet.scheduleNext();
      if (!context.placement) throw new MakerRuntimePlatformError('capacity_unavailable', 'no worker placement was produced', 503, {}, true);

      context.pluginSnapshot = plugins.snapshot();
      const requiredAuthority = unique(request.runtime_requirements?.authority || input.required_authority);
      context.pluginAuthority = derivePluginAuthority(context.pluginSnapshot, {
        required_capabilities: unique(input.plugin_capabilities),
        required_authority: requiredAuthority,
        approved_capabilities: unique(input.approved_capabilities),
        builtin_authority: input.builtin_authority || {}
      });
      context.runtimeProfile = buildRuntimeProfile({
        route: context.route,
        placement: context.placement,
        pluginAuthority: context.pluginAuthority,
        modelTask: { ...modelTask, role: modelTask.role || ({ planning: 'planner', repository_mapping: 'mapper', coding: 'implementer', debugging: 'debugger', review: 'reviewer', summarization: 'summarizer', browser_interpretation: 'browser', grading: 'grader' })[modelTask.type] || 'implementer' },
        planning: input.planning || {},
        clock
      });

      context.controlRequest = {
        ...request,
        repository: targetRepository,
        target_repository: targetRepository,
        runtime_requirements: {
          ...(request.runtime_requirements || {}),
          capabilities: unique(request.runtime_requirements?.capabilities || []),
          execution_roles: unique(request.runtime_requirements?.execution_roles || []),
          authority: requiredAuthority,
          recoverable: request.runtime_requirements?.recoverable !== false
        }
      };
      context.controlJob = await control.submit(context.controlRequest);
      controlClaim = await control.claim({ worker_id: context.placement.worker_id, runtime: context.runtimeProfile, repository: targetRepository });
      if (!controlClaim || controlClaim.id !== context.controlJob.id) throw new MakerRuntimePlatformError('control_claim_failed', 'selected runtime could not claim the durable job', 409, {}, true);
      context.controlJob = controlClaim;

      context.dispatch = await fleet.dispatch(context.placement, {
        platform_run_id: runId,
        job_id: context.controlJob.id,
        request: context.controlRequest,
        model_route: context.route,
        authority: context.pluginAuthority
      });
      if (!context.dispatch.ok) {
        const error = new MakerRuntimePlatformError(
          context.dispatch.error?.code || 'dispatch_failed',
          context.dispatch.error?.message || 'worker dispatch failed',
          502,
          { adapter: context.dispatch.adapter },
          input.dispatch_recoverable !== false
        );
        context.controlJob = await control.fail(context.controlJob.id, controlClaim.lease.token, error);
        fleet.cancel(fleetTaskId, error.message);
        context.presentation = await control.view(context.controlJob.id);
        return receipt(runId, 'failed', context, error);
      }

      await control.heartbeat(context.controlJob.id, controlClaim.lease.token);
      fleet.heartbeat(fleetTaskId, context.placement.lease.fencing_token);
      const result = context.dispatch.output?.result ?? context.dispatch.output ?? {};
      context.controlJob = await control.complete(context.controlJob.id, controlClaim.lease.token, {
        ...redactPlatformSecrets(result),
        platform_run_id: runId,
        model_route_digest: context.route.receipt_digest,
        placement_digest: context.placement.receipt_digest,
        plugin_registry_digest: context.pluginSnapshot.receipt_digest
      });
      context.fleetResult = fleet.finish(fleetTaskId, context.placement.lease.fencing_token, {
        cost_usd: context.dispatch.output?.cost_usd ?? 0,
        result_digest: platformDigest(result)
      });
      context.presentation = await control.view(context.controlJob.id);
      return receipt(runId, 'completed', context);
    } catch (caught) {
      const error = caught instanceof MakerRuntimePlatformError
        ? caught
        : new MakerRuntimePlatformError(clean(caught.code || 'platform_failed', 100), clean(caught.message || 'platform failed', 2000), caught.status || 500, caught.detail || {}, recoverableCode(caught.code));
      if (context.controlJob) {
        try {
          const current = await control.get(context.controlJob.id);
          if (current.state === 'running' && controlClaim?.lease?.token) {
            context.controlJob = await control.fail(current.id, controlClaim.lease.token, { code: error.code, message: error.message, recoverable: error.recoverable });
          } else if (current.state === 'queued') {
            context.controlJob = await control.cancel(current.id, error.message);
          }
          context.presentation = await control.view(current.id);
        } catch {}
      }
      if (fleetTaskId) {
        try { fleet.cancel(fleetTaskId, error.message); } catch {}
      }
      return receipt(runId, context.dispatch ? 'failed' : 'blocked', context, error);
    }
  }

  return Object.freeze({ run });
}
