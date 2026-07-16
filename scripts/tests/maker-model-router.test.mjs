import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ModelRouterError,
  TASK_PROFILES,
  createBudgetLedger,
  createModelRouter,
  createProviderRegistry,
  normalizeProviderDescriptor,
  normalizeTask,
  rankProviders,
  redactProviderSecrets,
  scoreProvider
} from '../maker-model-router.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}
const sha = value => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
const digest = letter => `sha256:${letter.repeat(64)}`;
function envelope(schema, payload) {
  const value = { schema, ...payload, issued_at: '2026-07-15T00:00:00.000Z' };
  return { ...value, digest: `sha256:${sha(value)}` };
}
function admittedNative(id = 'native-local') {
  const checkpoint = digest('c');
  const endpoint = digest('e');
  const runtimeId = `${id}-runtime`;
  const registry = envelope('sideways-maker-native-registry/v1', { checkpoint_digest: checkpoint, endpoint_digest: endpoint, runtime_id: runtimeId });
  const receipt = envelope('sideways-maker-native-admission/v1', { checkpoint_digest: checkpoint, endpoint_digest: endpoint, runtime_id: runtimeId, registry_digest: registry.digest });
  return baseProvider(id, {
    kind: 'native_checkpoint',
    locality: 'local',
    privacy: 'local',
    admission: { status: 'verified', receipt, registry, receipt_digest: receipt.digest, registry_digest: registry.digest },
    native: { checkpoint_digest: checkpoint, runtime_checkpoint_digest: checkpoint, endpoint_digest: endpoint, runtime_endpoint_digest: endpoint, runtime_id: runtimeId },
    public: { engine_label: 'Local Maker intelligence', endpoint_label: 'Your local Maker runtime' }
  });
}
const baseProvider = (id, overrides = {}) => ({
  id,
  kind: 'openai_compatible',
  display_name: id,
  availability: 'healthy',
  capabilities: {
    structured_json: { value: true, evidence: 'observed' },
    tool_use: { value: true, evidence: 'configured' },
    streaming: { value: true, evidence: 'configured' },
    multimodal: { value: false, evidence: 'observed' },
    reasoning: { value: true, evidence: 'observed' },
    coding: { value: true, evidence: 'observed' },
    browser_interpretation: { value: false, evidence: 'observed' }
  },
  limits: { context_tokens: 128000, output_tokens: 32000 },
  latency_class: 'interactive',
  privacy: 'no_training',
  locality: 'remote',
  region: 'us',
  cost: { input_per_million: 1, output_per_million: 2 },
  admission: { status: 'configured' },
  reliability: { successes: 9, failures: 1 },
  ...overrides
});
function deterministic() {
  let stamp = Date.parse('2026-07-15T00:00:00.000Z');
  let serial = 0;
  const sleeps = [];
  return {
    clock: () => stamp,
    id: () => `id-${++serial}`,
    advance: ms => { stamp += ms; },
    sleep: async ms => { sleeps.push(ms); stamp += ms; },
    sleeps
  };
}

test('provider descriptors cover every adapter kind and preserve evidence truth', () => {
  for (const kind of ['github_models', 'openai_compatible', 'ollama', 'anthropic_compatible', 'generic']) {
    const value = normalizeProviderDescriptor(baseProvider(kind, { kind }));
    assert.equal(value.kind, kind);
    assert.equal(value.capabilities.coding.evidence, 'observed');
    assert.equal(value.limits.context_tokens.evidence, 'configured');
    assert.match(value.descriptor_digest, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => normalizeProviderDescriptor({ id: 'bad', kind: 'vendor-sdk' }), /unsupported provider kind/);
});

test('missing limits and prices remain unknown rather than becoming unlimited or free', () => {
  const provider = normalizeProviderDescriptor({
    id: 'unknown', kind: 'generic', availability: 'healthy',
    capabilities: { coding: { value: true, evidence: 'configured' } },
    latency_class: 'interactive', privacy: 'no_training', locality: 'remote', region: 'us'
  });
  assert.equal(provider.limits.context_tokens.value, null);
  assert.equal(provider.cost.input_per_million.value, null);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding' })).reasons, ['context_limit_unknown']);
  const knownLimits = normalizeProviderDescriptor({ ...provider, id: 'unknown-cost', descriptor_digest: undefined, limits: { context_tokens: 100000, output_tokens: 10000 } });
  assert.deepEqual(scoreProvider(knownLimits, normalizeTask({ profile: 'coding', context_tokens: 1000, output_tokens: 100 })).reasons, ['cost_unknown']);
});

test('native admission requires digest-bound typed registry and admission receipts', () => {
  const admitted = normalizeProviderDescriptor(admittedNative());
  assert.equal(admitted.native.admitted, true);
  const selfAsserted = normalizeProviderDescriptor(baseProvider('fake-native', {
    kind: 'native_checkpoint',
    admission: { status: 'verified', receipt_digest: digest('a'), registry_digest: digest('b') },
    native: { checkpoint_digest: digest('c'), runtime_checkpoint_digest: digest('c'), endpoint_digest: digest('e'), runtime_endpoint_digest: digest('e'), runtime_id: 'fake' }
  }));
  assert.equal(selfAsserted.native.admitted, false);
  assert.deepEqual(scoreProvider(selfAsserted, normalizeTask({ profile: 'coding' })).reasons, ['native_not_admitted']);
  const tampered = admittedNative('tampered');
  tampered.admission.receipt = { ...tampered.admission.receipt, runtime_id: 'other' };
  assert.equal(normalizeProviderDescriptor(tampered).native.admitted, false);
  const endpointMismatch = admittedNative('endpoint-mismatch');
  endpointMismatch.native.runtime_endpoint_digest = digest('f');
  assert.equal(normalizeProviderDescriptor(endpointMismatch).native.admitted, false);
});

test('task profiles cover planning through independent grading', () => {
  for (const name of ['planning', 'repository_mapping', 'coding', 'debugging', 'review', 'summarization', 'browser_interpretation', 'grading']) {
    assert.ok(TASK_PROFILES[name]);
    assert.equal(normalizeTask({ profile: name }).profile, name);
  }
  const task = normalizeTask({ profile: 'coding', required_capabilities: ['multimodal'], provider_preference: ['p2', 'p1'] });
  assert.ok(task.required.includes('coding'));
  assert.ok(task.required.includes('multimodal'));
  assert.deepEqual(task.provider_preference, ['p2', 'p1']);
  assert.ok(task.budget.requests > 0);
});

test('capability filtering and deterministic scoring choose the strongest eligible provider', () => {
  const providers = [
    normalizeProviderDescriptor(baseProvider('z-cheap', { operator_weight: 0 })),
    normalizeProviderDescriptor(baseProvider('a-preferred', { operator_weight: 30 }))
  ];
  const task = normalizeTask({ profile: 'coding', provider_preference: ['a-preferred'] });
  const first = rankProviders(providers, task);
  const second = rankProviders([...providers].reverse(), task);
  assert.equal(first[0].provider.id, 'a-preferred');
  assert.deepEqual(first.map(item => [item.provider.id, item.score]), second.map(item => [item.provider.id, item.score]));
});

test('context, output, privacy, locality, region, cost, and availability filters fail closed', () => {
  const provider = normalizeProviderDescriptor(baseProvider('small', {
    limits: { context_tokens: 1000, output_tokens: 100 },
    privacy: 'provider_policy', locality: 'remote', region: 'eu',
    cost: { input_per_million: 100, output_per_million: 100 }
  }));
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 2000 })).reasons, ['context_overflow']);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 200 })).reasons, ['output_overflow']);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, privacy: 'private' })).reasons, ['privacy_mismatch']);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, locality: 'local' })).reasons, ['locality_mismatch']);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, region: 'us' })).reasons, ['region_mismatch']);
  assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, max_cost_usd: 0.001 })).reasons, ['cost_ceiling']);
  assert.deepEqual(scoreProvider(normalizeProviderDescriptor(baseProvider('offline', { availability: 'offline' })), normalizeTask({ profile: 'coding' })).reasons, ['offline']);
  assert.deepEqual(scoreProvider(normalizeProviderDescriptor(baseProvider('unknown', { availability: 'unknown' })), normalizeTask({ profile: 'coding' })).reasons, ['availability_unknown']);
});

test('latency ceilings and role pools are actual routing constraints', () => {
  const slow = normalizeProviderDescriptor(baseProvider('slow', { latency_class: 'batch' }));
  assert.deepEqual(scoreProvider(slow, normalizeTask({ profile: 'coding', max_latency_class: 'interactive' })).reasons, ['latency_too_slow']);
  const roleBound = normalizeProviderDescriptor(baseProvider('planner-only', { roles: ['planning'] }));
  assert.deepEqual(scoreProvider(roleBound, normalizeTask({ profile: 'coding' })).reasons, ['role_mismatch']);
  assert.equal(scoreProvider(roleBound, normalizeTask({ profile: 'planning' })).eligible, true);
});

test('budget ledger supports preflight checks and enforces all ceilings', () => {
  const ledger = createBudgetLedger({ requests: 2, input_tokens: 100, output_tokens: 50, cost_usd: 1, wall_time_ms: 1000 });
  ledger.check({ requests: 1, input_tokens: 40 });
  assert.equal(ledger.snapshot().used.requests, 0);
  ledger.admit({ requests: 1, input_tokens: 40, output_tokens: 20, cost_usd: 0.4, wall_time_ms: 300 });
  assert.equal(ledger.snapshot().remaining.requests, 1);
  assert.throws(() => ledger.admit({ requests: 2 }), error => error.code === 'budget_exhausted' && error.detail.key === 'requests');
  assert.throws(() => ledger.admit({ input_tokens: 61 }), error => error.detail.key === 'input_tokens');
});

test('provider usage distinguishes reported, estimated, and mixed evidence', async () => {
  const d = deterministic();
  const reported = createModelRouter({
    registry: createProviderRegistry([baseProvider('reported')]), clock: d.clock, id: d.id,
    transports: { reported: async () => ({ output: { ok: true }, usage: { input_tokens: 11, output_tokens: 7, cost_usd: 0.02 } }) }
  });
  const first = await reported.route({ profile: 'coding', output_schema: { type: 'object', required: ['ok'] } });
  assert.equal(first.attempts[0].usage.evidence, 'provider_reported');
  const mixed = createModelRouter({
    registry: createProviderRegistry([baseProvider('mixed')]), clock: d.clock, id: d.id,
    transports: { mixed: async () => ({ output: { ok: true }, usage: { input_tokens: 11 } }) }
  });
  const second = await mixed.route({ profile: 'coding', context_tokens: 100, output_tokens: 20, output_schema: { type: 'object' } });
  assert.equal(second.attempts[0].usage.evidence, 'mixed');
  assert.equal(second.attempts[0].usage.field_evidence.output_tokens, 'estimated');
  const estimated = createModelRouter({ registry: createProviderRegistry([baseProvider('estimated')]), clock: d.clock, id: d.id, transports: { estimated: async () => ({ output: { ok: true } }) } });
  const third = await estimated.route({ profile: 'coding', context_tokens: 100, output_tokens: 20, output_schema: { type: 'object' } });
  assert.equal(third.attempts[0].usage.evidence, 'estimated');
});

test('structured validation handles integers and bounded schema repair', async () => {
  const calls = [];
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('repair')]), repair_attempts: 1,
    transports: { repair: async packet => { calls.push(packet); return packet.repair ? { output: { count: 2 } } : { output: { count: 'two' } }; } }
  });
  const receipt = await router.route({
    profile: 'summarization',
    output_schema: { type: 'object', required: ['count'], additionalProperties: false, properties: { count: { type: 'integer', minimum: 1 } } }
  });
  assert.equal(receipt.output.count, 2);
  assert.equal(receipt.attempts[0].status, 'schema_invalid');
  assert.equal(receipt.attempts.at(-1).status, 'success');
  assert.ok(calls[1].repair.errors[0].includes('count'));
});

test('invalid JSON receives one bounded repair prompt', async () => {
  let calls = 0;
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('json-repair')]), repair_attempts: 1,
    transports: { 'json-repair': async packet => { calls += 1; return { output: packet.repair ? '{"ok":true}' : 'not json' }; } }
  });
  const receipt = await router.route({ profile: 'summarization', output_schema: { type: 'object', required: ['ok'] } });
  assert.equal(receipt.output.ok, true);
  assert.equal(calls, 2);
});

test('rate limits use bounded backoff, account wall time, and preserve state', async () => {
  const d = deterministic();
  let calls = 0;
  const states = [];
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('rate')]), clock: d.clock, sleep: d.sleep, id: d.id, retries: 1, repair_attempts: 0,
    transports: { rate: async packet => { calls += 1; states.push(packet.task.state); if (calls === 1) throw new ModelRouterError('rate_limited', '429', 429); return { output: { ok: true } }; } }
  });
  const receipt = await router.route({ profile: 'coding', state: { checkpoint: 7 }, output_schema: { type: 'object', required: ['ok'] } });
  assert.equal(receipt.output.ok, true);
  assert.deepEqual(d.sleeps, [1000]);
  assert.deepEqual(states, [{ checkpoint: 7 }, { checkpoint: 7 }]);
  assert.ok(receipt.budget.task.used.wall_time_ms >= 1000);
});

test('fallback chain preserves state and succeeds on the next ranked provider', async () => {
  const seen = [];
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('first', { operator_weight: 100 }), baseProvider('second')]), retries: 0, repair_attempts: 0,
    transports: {
      first: async packet => { seen.push(['first', packet.task.state]); throw new Error('offline'); },
      second: async packet => { seen.push(['second', packet.task.state]); return { output: { provider: 'second' } }; }
    }
  });
  const receipt = await router.route({ profile: 'coding', state: { memory: ['a'] }, output_schema: { type: 'object' } });
  assert.equal(receipt.selected_provider, 'second');
  assert.deepEqual(seen[0][1], seen[1][1]);
  assert.equal(receipt.attempts[0].status, 'failed');
});

test('fallback exhaustion returns exact redacted attempt evidence', async () => {
  const router = createModelRouter({ registry: createProviderRegistry([baseProvider('broken')]), retries: 0, repair_attempts: 0, transports: { broken: async () => { throw new Error('Bearer abcdefghijklmnopqrstuvwxyz'); } } });
  await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'fallback_exhausted' && error.detail.attempts.length === 1 && !JSON.stringify(error.detail).includes('abcdefghijklmnopqrstuvwxyz'));
});

test('circuit breaker opens after repeated failures and health reports it', async () => {
  const d = deterministic();
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('circuit')]), clock: d.clock, id: d.id, retries: 0, repair_attempts: 0, circuit_threshold: 2,
    transports: { circuit: async () => { throw new Error('boom'); } }
  });
  await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'fallback_exhausted');
  await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'fallback_exhausted');
  await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'no_provider');
  assert.ok(router.health().circuits.circuit.open_until > d.clock());
});

test('explicit provider pools restrict routing and empty pools fail truthfully', async () => {
  const router = createModelRouter({ registry: createProviderRegistry([baseProvider('planner'), baseProvider('coder')]), transports: { planner: async () => ({ output: { ok: true } }), coder: async () => ({ output: { ok: true } }) } });
  const receipt = await router.route({ profile: 'planning', output_schema: { type: 'object' } }, { provider_pool: ['planner'] });
  assert.equal(receipt.selected_provider, 'planner');
  await assert.rejects(router.route({ profile: 'coding' }, { provider_pool: ['missing'] }), error => error.code === 'no_provider');
});

test('independent grader cannot reuse the source provider', async () => {
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('source', { operator_weight: 100 }), baseProvider('grader')]),
    transports: { source: async () => ({ output: { score: 1 } }), grader: async () => ({ output: { score: 0.9 } }) }
  });
  const source = await router.route({ profile: 'coding', output_schema: { type: 'object' } });
  assert.equal(source.selected_provider, 'source');
  const grade = await router.grade({ output_schema: { type: 'object', required: ['score'] } }, source);
  assert.equal(grade.selected_provider, 'grader');
});

test('admitted local checkpoint produces provider-independent runtime projection', async () => {
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('remote'), admittedNative()]),
    transports: { 'native-local': async () => ({ output: { ok: true }, public_runtime: { capacity: 'dedicated', throttling: 'none' } }) }
  });
  const receipt = await router.route({ profile: 'coding', locality: 'local', privacy: 'local', output_schema: { type: 'object' } });
  assert.equal(receipt.selected_provider, 'native-local');
  assert.equal(receipt.runtime_profile.intelligence.architecture, 'native');
  assert.equal(receipt.runtime_profile.intelligence.admission, 'verified');
  assert.equal(receipt.runtime_profile.endpoint.ownership, 'user');
  assert.ok(!receipt.runtime_profile.runtime_id.includes('native-local'));
});

test('public runtime ignores raw response model and endpoint metadata and normalizes enums', async () => {
  const router = createModelRouter({
    registry: createProviderRegistry([baseProvider('vendor-model-raw')]),
    transports: {
      'vendor-model-raw': async () => ({
        output: { ok: true }, engine_label: 'sk-abcdefghijklmnop', endpoint_label: 'https://secret.example', runtime_id: 'vendor-runtime',
        public_runtime: { engine_label: 'https://secret.example/model', endpoint_label: 'Bearer abcdefghijklmnopqrstuvwxyz', capacity: 'infinite', throttling: 'wild' }
      })
    }
  });
  const receipt = await router.route({ profile: 'coding', output_schema: { type: 'object' } });
  const publicText = JSON.stringify(receipt.runtime_profile);
  assert.ok(!publicText.includes('secret.example'));
  assert.ok(!publicText.includes('vendor-model-raw'));
  assert.ok(!publicText.includes('vendor-runtime'));
  assert.equal(receipt.runtime_profile.endpoint.capacity, 'unknown');
  assert.equal(receipt.runtime_profile.endpoint.throttling, 'unknown');
});

test('receipts redact credentials and have deterministic integrity fields', async () => {
  const d = deterministic();
  const router = createModelRouter({
    id: d.id, clock: d.clock,
    registry: createProviderRegistry([baseProvider('safe', { metadata: { api_key: 'sk-abcdefghijklmnop', endpoint_url: 'https://secret.example' } })]),
    transports: { safe: async () => ({ output: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', ok: true } }) }
  });
  const receipt = await router.route({ profile: 'coding', state: { token: 'ghp_' + 'x'.repeat(30) }, output_schema: { type: 'object', required: ['ok'] } });
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!serialized.includes('ghp_'));
  assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
  assert.match(receipt.state_digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.task_id, 'id-1');
});

test('registry health distinguishes all availability states', () => {
  const registry = createProviderRegistry([
    baseProvider('healthy'), baseProvider('degraded', { availability: 'degraded' }),
    baseProvider('offline', { availability: 'offline' }), baseProvider('unknown', { availability: 'unknown' })
  ]);
  const health = registry.health();
  assert.deepEqual({ healthy: health.healthy, degraded: health.degraded, offline: health.offline, unknown: health.unknown }, { healthy: 1, degraded: 1, offline: 1, unknown: 1 });
});

test('health probes update observed state while stripping endpoint and model metadata', async () => {
  const registry = createProviderRegistry([baseProvider('probe', { availability: 'unknown' })]);
  const router = createModelRouter({
    registry,
    health_checks: { probe: async () => ({ status: 'healthy', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', endpoint_url: 'https://secret.example', model_id: 'raw-model', latency_ms: 12 }) }
  });
  const receipt = await router.probe('probe');
  assert.equal(receipt.status, 'healthy');
  assert.equal(registry.get('probe').availability, 'healthy');
  assert.equal(receipt.detail.authorization, '[redacted]');
  assert.equal(receipt.detail.endpoint_url, '[redacted]');
  assert.equal(receipt.detail.model_id, '[redacted]');
  assert.ok(!JSON.stringify(receipt).includes('secret.example'));
});

test('health probe failures mark providers offline with bounded evidence', async () => {
  const registry = createProviderRegistry([baseProvider('dead', { availability: 'healthy' })]);
  const router = createModelRouter({ registry, health_checks: { dead: async () => { throw new Error('Bearer abcdefghijklmnopqrstuvwxyz'); } } });
  const receipt = await router.probe('dead');
  assert.equal(receipt.status, 'offline');
  assert.equal(registry.get('dead').availability, 'offline');
  assert.ok(!JSON.stringify(receipt).includes('abcdefghijklmnopqrstuvwxyz'));
});

test('global budget preflight prevents a provider call before expenditure', async () => {
  let called = false;
  const router = createModelRouter({
    global_budget: { requests: 0, input_tokens: 1_000_000, output_tokens: 1_000_000, cost_usd: 100, wall_time_ms: 1000 },
    registry: createProviderRegistry([baseProvider('bounded')]),
    transports: { bounded: async () => { called = true; return { output: { ok: true } }; } }
  });
  await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'budget_exhausted');
  assert.equal(called, false);
});

test('attempt timeout supplies AbortSignal and reports indeterminate timeout evidence', async () => {
  let aborted = false;
  const router = createModelRouter({
    attempt_timeout_ms: 10, retries: 0, repair_attempts: 0,
    registry: createProviderRegistry([baseProvider('hung')]),
    transports: { hung: packet => new Promise(() => packet.signal.addEventListener('abort', () => { aborted = true; })) }
  });
  await assert.rejects(router.route({ profile: 'coding', max_wall_time_ms: 100 }), error => {
    assert.equal(error.code, 'fallback_exhausted');
    assert.equal(error.detail.attempts[0].status, 'timeout');
    assert.equal(error.detail.attempts[0].error.indeterminate, true);
    return true;
  });
  assert.equal(aborted, true);
});

test('provider-reported task cost overrun fails instead of returning success', async () => {
  let called = 0;
  const router = createModelRouter({
    retries: 0, repair_attempts: 0,
    registry: createProviderRegistry([baseProvider('expensive', { cost: { input_per_million: 0.01, output_per_million: 0.01 } })]),
    transports: { expensive: async () => { called += 1; return { output: { ok: true }, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 1 } }; } }
  });
  await assert.rejects(router.route({ profile: 'coding', max_cost_usd: 0.1, output_schema: { type: 'object' } }), error => ['budget_exhausted', 'task_cost_exceeded'].includes(error.code));
  assert.equal(called, 1);
});

test('terminal schema failure records one evidence item per provider invocation', async () => {
  const router = createModelRouter({
    retries: 0, repair_attempts: 0,
    registry: createProviderRegistry([baseProvider('invalid')]),
    transports: { invalid: async () => ({ output: { wrong: true } }) }
  });
  await assert.rejects(router.route({ profile: 'summarization', output_schema: { type: 'object', required: ['answer'] } }), error => {
    assert.equal(error.code, 'fallback_exhausted');
    assert.equal(error.detail.attempts.length, 1);
    assert.equal(error.detail.attempts[0].status, 'schema_invalid');
    return true;
  });
});

test('router health has a stable typed wrapper matching the contract', () => {
  const router = createModelRouter({ registry: createProviderRegistry([baseProvider('health')]) });
  const health = router.health();
  assert.equal(health.schema, 'sideways-maker-model-router-health/v1');
  assert.equal(health.registry.schema, 'sideways-maker-provider-health/v1');
  assert.equal(health.budget.schema, 'sideways-maker-model-budget/v1');
  assert.ok(health.observed_at);
});

test('secret redaction remains recursive and bounded', () => {
  const safe = redactProviderSecrets({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', nested: { api_key: 'sk-abcdefghijklmnop' } });
  assert.equal(safe.authorization, '[redacted]');
  assert.equal(safe.nested.api_key, '[redacted]');
});

test('published schema covers provider, task, route attempts, budgets, health, probes, and native receipts', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../../maker/contracts/model-router.schema.json', import.meta.url), 'utf8'));
  const refs = new Set(schema.oneOf.map(entry => entry.$ref));
  for (const name of ['provider', 'task', 'providerAttempt', 'routeAttempt', 'routeReceipt', 'budget', 'providerHealth', 'routerHealth', 'probe', 'nativeAdmission', 'nativeRegistry']) {
    assert.ok(refs.has(`#/$defs/${name}`), `missing top-level ${name} schema`);
  }
  assert.equal(schema.$defs.routeReceipt.properties.runtime_profile.$ref, '#/$defs/runtimeProfile');
  assert.equal(schema.$defs.routeReceipt.properties.attempts.items.$ref, '#/$defs/routeAttempt');
  assert.ok(schema.$defs.usageEvidence.enum.includes('mixed'));
  assert.equal(schema.$defs.routerHealth.properties.schema.const, 'sideways-maker-model-router-health/v1');
});
