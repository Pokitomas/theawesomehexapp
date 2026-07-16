import assert from 'node:assert/strict';
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
const digest = letter => `sha256:${letter.repeat(64)}`;
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
test('provider descriptors cover every adapter kind and mark evidence truthfully', () => {
for (const kind of ['github_models', 'openai_compatible', 'ollama', 'anthropic_compatible', 'generic']) {
const value = normalizeProviderDescriptor(baseProvider(kind, { kind }));
assert.equal(value.kind, kind);
assert.equal(value.capabilities.coding.evidence, 'observed');
assert.equal(value.limits.context_tokens.evidence, 'configured');
assert.match(value.descriptor_digest, /^[a-f0-9]{64}$/);
}
assert.throws(() => normalizeProviderDescriptor({ id: 'bad', kind: 'vendor-sdk' }), /unsupported provider kind/);
});
test('native checkpoints require verified admission receipts and exact runtime digest match', () => {
const admitted = normalizeProviderDescriptor(baseProvider('native', {
kind: 'native_checkpoint',
locality: 'local',
privacy: 'local',
admission: { status: 'verified', receipt_digest: digest('a'), registry_digest: digest('b') },
native: { checkpoint_digest: digest('c'), runtime_checkpoint_digest: digest('c'), runtime_id: 'native-1' }
}));
assert.equal(admitted.native.admitted, true);
const mismatch = normalizeProviderDescriptor(baseProvider('native-bad', {
kind: 'native_checkpoint',
admission: { status: 'verified', receipt_digest: digest('a'), registry_digest: digest('b') },
native: { checkpoint_digest: digest('c'), runtime_checkpoint_digest: digest('d') }
}));
assert.equal(mismatch.native.admitted, false);
assert.equal(scoreProvider(mismatch, normalizeTask({ profile: 'coding' })).eligible, false);
});
test('task profiles cover planning through grading and normalize hard requirements', () => {
for (const name of ['planning', 'repository_mapping', 'coding', 'debugging', 'review', 'summarization', 'browser_interpretation', 'grading']) {
assert.ok(TASK_PROFILES[name]);
assert.equal(normalizeTask({ profile: name }).profile, name);
}
const task = normalizeTask({ profile: 'coding', required_capabilities: ['multimodal'], provider_preference: ['p2', 'p1'] });
assert.ok(task.required.includes('coding'));
assert.ok(task.required.includes('multimodal'));
assert.deepEqual(task.provider_preference, ['p2', 'p1']);
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
privacy: 'provider_policy',
locality: 'remote',
region: 'eu',
cost: { input_per_million: 100, output_per_million: 100 }
}));
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 2000 })).reasons, ['context_overflow']);
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 200 })).reasons, ['output_overflow']);
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, privacy: 'private' })).reasons, ['privacy_mismatch']);
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, locality: 'local' })).reasons, ['locality_mismatch']);
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, region: 'us' })).reasons, ['region_mismatch']);
assert.deepEqual(scoreProvider(provider, normalizeTask({ profile: 'coding', context_tokens: 100, output_tokens: 50, max_cost_usd: 0.001 })).reasons, ['cost_ceiling']);
const offline = normalizeProviderDescriptor(baseProvider('offline', { availability: 'offline' }));
assert.deepEqual(scoreProvider(offline, normalizeTask({ profile: 'coding' })).reasons, ['offline']);
});
test('budget ledger enforces request, token, cost, and wall-time ceilings', () => {
const ledger = createBudgetLedger({ requests: 2, input_tokens: 100, output_tokens: 50, cost_usd: 1, wall_time_ms: 1000 });
ledger.admit({ requests: 1, input_tokens: 40, output_tokens: 20, cost_usd: 0.4, wall_time_ms: 300 });
assert.equal(ledger.snapshot().remaining.requests, 1);
assert.throws(() => ledger.admit({ requests: 2 }), error => error.code === 'budget_exhausted' && error.detail.key === 'requests');
assert.throws(() => ledger.admit({ input_tokens: 61 }), error => error.detail.key === 'input_tokens');
});
test('provider-reported usage is preserved while absent usage is marked estimated', async () => {
const registry = createProviderRegistry([baseProvider('reported')]);
const d = deterministic();
const reported = createModelRouter({
registry, clock: d.clock, id: d.id,
transports: { reported: async () => ({ output: { ok: true }, usage: { input_tokens: 11, output_tokens: 7, cost_usd: 0.02 } }) }
});
const receipt = await reported.route({ profile: 'coding', output_schema: { type: 'object', required: ['ok'] } });
assert.equal(receipt.attempts[0].usage.evidence, 'provider_reported');
assert.equal(receipt.attempts[0].usage.input_tokens, 11);
const estimatedRegistry = createProviderRegistry([baseProvider('estimated')]);
const estimated = createModelRouter({ registry: estimatedRegistry, clock: d.clock, id: d.id, transports: { estimated: async () => ({ output: { ok: true } }) } });
const second = await estimated.route({ profile: 'coding', context_tokens: 100, output_tokens: 20, output_schema: { type: 'object' } });
assert.equal(second.attempts[0].usage.evidence, 'estimated');
});
test('structured output validation emits repair context and succeeds within bounds', async () => {
const registry = createProviderRegistry([baseProvider('repair')]);
const calls = [];
const router = createModelRouter({
registry,
repair_attempts: 1,
transports: {
repair: async packet => {
calls.push(packet);
return packet.repair ? { output: { answer: 'fixed' } } : { output: { wrong: true } };
}
}
});
const receipt = await router.route({
profile: 'summarization',
output_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
});
assert.equal(receipt.output.answer, 'fixed');
assert.equal(receipt.attempts[0].status, 'schema_invalid');
assert.equal(receipt.attempts.at(-1).status, 'success');
assert.ok(calls[1].repair.errors[0].includes('answer'));
});
test('invalid JSON receives a bounded repair prompt', async () => {
const registry = createProviderRegistry([baseProvider('json-repair')]);
let calls = 0;
const router = createModelRouter({
registry,
repair_attempts: 1,
transports: {
'json-repair': async packet => {
calls += 1;
return { output: packet.repair ? '{"ok":true}' : 'not json' };
}
}
});
const receipt = await router.route({ profile: 'summarization', output_schema: { type: 'object', required: ['ok'] } });
assert.equal(receipt.output.ok, true);
assert.equal(calls, 2);
});
test('rate limits use bounded backoff and retry without losing task state', async () => {
const registry = createProviderRegistry([baseProvider('rate')]);
const d = deterministic();
let calls = 0;
const states = [];
const router = createModelRouter({
registry, clock: d.clock, sleep: d.sleep, id: d.id, retries: 1, repair_attempts: 0,
transports: {
rate: async packet => {
calls += 1;
states.push(packet.task.state);
if (calls === 1) throw new ModelRouterError('rate_limited', '429', 429);
return { output: { ok: true } };
}
}
});
const receipt = await router.route({ profile: 'coding', state: { checkpoint: 7 }, output_schema: { type: 'object', required: ['ok'] } });
assert.equal(receipt.output.ok, true);
assert.deepEqual(d.sleeps, [1000]);
assert.deepEqual(states, [{ checkpoint: 7 }, { checkpoint: 7 }]);
});
test('fallback chain preserves state and succeeds on the next ranked provider', async () => {
const registry = createProviderRegistry([
baseProvider('first', { operator_weight: 100 }),
baseProvider('second')
]);
const seen = [];
const router = createModelRouter({
registry, retries: 0, repair_attempts: 0,
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
const registry = createProviderRegistry([baseProvider('broken')]);
const router = createModelRouter({ registry, retries: 0, repair_attempts: 0, transports: { broken: async () => { throw new Error('Bearer abcdefghijklmnopqrstuvwxyz'); } } });
await assert.rejects(
router.route({ profile: 'coding' }),
error => error.code === 'fallback_exhausted' && error.detail.attempts.length === 1 && !JSON.stringify(error.detail).includes('abcdefghijklmnopqrstuvwxyz')
);
});
test('circuit breaker opens after repeated failures and health reports it', async () => {
const registry = createProviderRegistry([baseProvider('circuit')]);
const d = deterministic();
const router = createModelRouter({
registry, clock: d.clock, id: d.id, retries: 0, repair_attempts: 0, circuit_threshold: 2,
transports: { circuit: async () => { throw new Error('boom'); } }
});
await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'fallback_exhausted');
await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'fallback_exhausted');
await assert.rejects(router.route({ profile: 'coding' }), error => error.code === 'no_provider');
assert.ok(router.health().circuits.circuit.open_until > d.clock());
});
test('role-specific pools restrict routing and empty pools fail truthfully', async () => {
const registry = createProviderRegistry([baseProvider('planner'), baseProvider('coder')]);
const router = createModelRouter({ registry, transports: { planner: async () => ({ output: { ok: true } }), coder: async () => ({ output: { ok: true } }) } });
const receipt = await router.route({ profile: 'planning', output_schema: { type: 'object' } }, { provider_pool: ['planner'] });
assert.equal(receipt.selected_provider, 'planner');
await assert.rejects(router.route({ profile: 'coding' }, { provider_pool: ['missing'] }), error => error.code === 'no_provider');
});
test('independent grader cannot reuse the source provider', async () => {
const registry = createProviderRegistry([baseProvider('source', { operator_weight: 100 }), baseProvider('grader')]);
const router = createModelRouter({
registry,
transports: {
source: async () => ({ output: { score: 1 } }),
grader: async () => ({ output: { score: 0.9 } })
}
});
const source = await router.route({ profile: 'coding', output_schema: { type: 'object' } });
assert.equal(source.selected_provider, 'source');
const grade = await router.grade({ output_schema: { type: 'object', required: ['score'] } }, source);
assert.equal(grade.selected_provider, 'grader');
});
test('privacy and locality preferences select an admitted local checkpoint', async () => {
const native = baseProvider('native-local', {
kind: 'native_checkpoint', locality: 'local', privacy: 'local',
admission: { status: 'verified', receipt_digest: digest('a'), registry_digest: digest('b') },
native: { checkpoint_digest: digest('c'), runtime_checkpoint_digest: digest('c'), runtime_id: 'native-runtime' }
});
const registry = createProviderRegistry([baseProvider('remote'), native]);
const router = createModelRouter({ registry, transports: { 'native-local': async () => ({ output: { ok: true }, endpoint_label: 'Your local Maker', capacity: 'dedicated', throttling: 'none' }) } });
const receipt = await router.route({ profile: 'coding', locality: 'local', privacy: 'local', output_schema: { type: 'object' } });
assert.equal(receipt.selected_provider, 'native-local');
assert.equal(receipt.runtime_profile.intelligence.architecture, 'native');
assert.equal(receipt.runtime_profile.intelligence.admission, 'verified');
assert.equal(receipt.runtime_profile.endpoint.ownership, 'user');
});
test('receipts hide provider secrets and have deterministic integrity digests', async () => {
const registry = createProviderRegistry([baseProvider('safe', { metadata: { api_key: 'sk-abcdefghijklmnop', endpoint_url: 'https://secret.example' } })]);
const router = createModelRouter({ transports: { safe: async () => ({ output: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', ok: true }, engine_label: 'Adaptive Engine' }) }, registry });
const receipt = await router.route({ profile: 'coding', state: { token: 'ghp_' + 'x'.repeat(30) }, output_schema: { type: 'object', required: ['ok'] } });
const serialized = JSON.stringify(receipt);
assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));
assert.ok(!serialized.includes('ghp_'));
assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
assert.match(receipt.state_digest, /^[a-f0-9]{64}$/);
assert.equal(receipt.runtime_profile.intelligence.engine_label, 'Adaptive Engine');
});
test('registry health distinguishes healthy, degraded, offline, and unknown providers', () => {
const registry = createProviderRegistry([
baseProvider('healthy'),
baseProvider('degraded', { availability: 'degraded' }),
baseProvider('offline', { availability: 'offline' }),
baseProvider('unknown', { availability: 'unknown' })
]);
const health = registry.health();
assert.deepEqual({ healthy: health.healthy, degraded: health.degraded, offline: health.offline, unknown: health.unknown }, { healthy: 1, degraded: 1, offline: 1, unknown: 1 });
});
test('health probes update observed provider state and redact endpoint credentials', async () => {
const registry = createProviderRegistry([baseProvider('probe', { availability: 'unknown' })]);
const router = createModelRouter({
registry,
health_checks: {
probe: async () => ({ status: 'healthy', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', latency_ms: 12 })
}
});
const receipt = await router.probe('probe');
assert.equal(receipt.schema, 'sideways-maker-provider-probe/v1');
assert.equal(receipt.status, 'healthy');
assert.equal(registry.get('probe').availability, 'healthy');
assert.equal(receipt.detail.authorization, '[redacted]');
assert.ok(!JSON.stringify(registry.get('probe')).includes('abcdefghijklmnopqrstuvwxyz'));
});
test('health probe failures mark providers offline with bounded evidence', async () => {
const registry = createProviderRegistry([baseProvider('dead', { availability: 'healthy' })]);
const router = createModelRouter({
registry,
health_checks: { dead: async () => { throw new Error('Bearer abcdefghijklmnopqrstuvwxyz'); } }
});
const receipt = await router.probe('dead');
assert.equal(receipt.status, 'offline');
assert.equal(registry.get('dead').availability, 'offline');
assert.ok(!JSON.stringify(receipt).includes('abcdefghijklmnopqrstuvwxyz'));
});
test('published model-router schema covers provider, task, attempt, routing, budget, health, and probe receipts', async () => {
const schema = JSON.parse(await fs.readFile(
new URL('../../maker/contracts/model-router.schema.json', import.meta.url),
'utf8'
));
const refs = new Set(schema.oneOf.map(entry => entry.$ref));
for (const name of ['provider', 'task', 'attempt', 'routeReceipt', 'budget', 'health', 'probe']) {
assert.ok(refs.has(`#/$defs/${name}`), `missing top-level ${name} schema`);
}
assert.equal(schema.$defs.provider.properties.schema.const, 'sideways-maker-provider/v1');
assert.equal(schema.$defs.routeReceipt.properties.runtime_profile.$ref, '#/$defs/runtimeProfile');
assert.ok(schema.$defs.task.properties.profile.enum.includes('grading'));
});
