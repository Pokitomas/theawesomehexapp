import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MakerModelRouterError,
  createBudgetLedger,
  createModelRouter,
  normalizeProviderDescriptor,
  normalizeTaskProfile,
  receiptDigest,
  redactProviderSecrets,
  scoreProvider,
  selectProviders,
  validateStructuredOutput,
  verifyNativeAdmission
} from '../maker-model-router.mjs';

const baseProvider = overrides => ({
  id: 'provider-a',
  display_name: 'Provider A',
  kind: 'openai_compatible',
  health: 'healthy',
  availability: { value: true, source: 'observed' },
  capabilities: {
    structured_json: { value: true, source: 'observed' },
    tool_use: { value: true, source: 'observed' },
    streaming: { value: true, source: 'configured' },
    multimodal: { value: false, source: 'observed' },
    context_tokens: { value: 128000, source: 'observed' },
    output_tokens: { value: 32000, source: 'observed' },
    latency_class: { value: 'fast', source: 'observed' },
    privacy: { value: 'private', source: 'configured' },
    region: { value: 'us-west', source: 'configured' },
    locality: { value: 'remote', source: 'observed' }
  },
  cost: { input_per_million_usd: 1, output_per_million_usd: 2, request_usd: 0 },
  reliability: { success_rate: 0.98, samples: 100, consecutive_failures: 0 },
  ...overrides
});

function deterministic() {
  let tick = Date.parse('2026-07-15T00:00:00.000Z');
  let serial = 0;
  return {
    clock: () => tick,
    id: () => `route-${++serial}`,
    sleep: async ms => { tick += ms; },
    advance: ms => { tick += ms; }
  };
}

test('normalizes descriptors for every provider kind with evidence provenance', () => {
  for (const kind of ['github_models', 'openai_compatible', 'ollama', 'anthropic_compatible', 'configured']) {
    const provider = normalizeProviderDescriptor(baseProvider({ id: kind, kind }));
    assert.equal(provider.kind, kind);
    assert.equal(provider.capabilities.structured_json.source, 'observed');
    assert.equal(provider.capabilities.streaming.source, 'configured');
    assert.equal(provider.selectable, true);
    assert.match(provider.descriptor_digest, /^[a-f0-9]{64}$/);
  }
});

test('native checkpoints require verified matching admission and runtime digests', () => {
  const admitted = normalizeProviderDescriptor(baseProvider({
    id: 'native-ok',
    kind: 'native_checkpoint',
    native: {
      checkpoint_digest: 'sha256:abc',
      runtime_checkpoint_digest: 'sha256:abc',
      runtime_id: 'runtime-1',
      admission: { verified: true, checkpoint_digest: 'sha256:abc', runtime_id: 'runtime-1' }
    }
  }));
  assert.equal(verifyNativeAdmission(admitted).admitted, true);
  assert.equal(admitted.selectable, true);
  const mismatch = normalizeProviderDescriptor(baseProvider({
    id: 'native-bad',
    kind: 'native_checkpoint',
    native: {
      checkpoint_digest: 'sha256:abc',
      runtime_checkpoint_digest: 'sha256:def',
      admission: { verified: true, checkpoint_digest: 'sha256:abc' }
    }
  }));
  assert.equal(mismatch.selectable, false);
  assert.equal(mismatch.native_admission.reason, 'runtime_checkpoint_mismatch');
});

test('task profiles cover planning, mapping, coding, debugging, review, summarization, browser, and grading', () => {
  const types = ['planning', 'repository_mapping', 'coding', 'debugging', 'review', 'summarization', 'browser_interpretation', 'grading'];
  for (const type of types) {
    const task = normalizeTaskProfile({ type });
    assert.equal(task.type, type);
    assert.ok(task.context_tokens > 0);
    assert.ok(task.output_tokens > 0);
  }
  assert.ok(normalizeTaskProfile({ type: 'browser_interpretation' }).required.includes('multimodal'));
});

test('hard capability and context filtering rejects ineligible providers', () => {
  const provider = normalizeProviderDescriptor(baseProvider({
    capabilities: { ...baseProvider().capabilities, tool_use: false, context_tokens: 8000 }
  }));
  const score = scoreProvider(provider, normalizeTaskProfile({ type: 'coding', context_tokens: 16000 }));
  assert.equal(score.eligible, false);
  assert.ok(score.failures.includes('missing:tool_use'));
  assert.ok(score.failures.includes('context_overflow'));
});

test('deterministic scoring prefers reliability, privacy, locality, and operator preference', () => {
  const remote = normalizeProviderDescriptor(baseProvider({ id: 'remote' }));
  const local = normalizeProviderDescriptor(baseProvider({
    id: 'local',
    kind: 'ollama',
    capabilities: {
      ...baseProvider().capabilities,
      privacy: { value: 'local', source: 'observed' },
      locality: { value: 'local', source: 'observed' }
    },
    reliability: { success_rate: 0.95, samples: 100 }
  }));
  const task = normalizeTaskProfile({ type: 'coding', locality_preference: 'local', privacy_minimum: 'private', operator_preference: ['local'] });
  const first = selectProviders([remote, local], task);
  const second = selectProviders([remote, local], task);
  assert.deepEqual(first, second);
  assert.equal(first[0].provider_id, 'local');
});

test('cost ceilings reject otherwise capable providers', () => {
  const expensive = normalizeProviderDescriptor(baseProvider({
    cost: { input_per_million_usd: 100, output_per_million_usd: 100, request_usd: 10 }
  }));
  const score = scoreProvider(expensive, normalizeTaskProfile({ type: 'coding', max_cost_usd: 1 }));
  assert.equal(score.eligible, false);
  assert.ok(score.failures.includes('cost_ceiling'));
});

test('budget ledger marks provider-reported and estimated usage explicitly', () => {
  const ledger = createBudgetLedger({ requests: 3, input_tokens: 1000, output_tokens: 1000, cost_usd: 10, wall_time_ms: 10000 });
  const reported = ledger.record('task-a', { input_tokens: 100, output_tokens: 20, cost_usd: 1, wall_time_ms: 10, reported: true });
  const estimated = ledger.record('task-a', { input_tokens: 50, output_tokens: 10, cost_usd: 0.5, wall_time_ms: 5, reported: false });
  assert.equal(reported.source, 'provider_reported');
  assert.equal(estimated.source, 'estimated');
  assert.equal(ledger.snapshot().usage.requests, 2);
});

test('budget ledger fails closed on per-task and global exhaustion', () => {
  const ledger = createBudgetLedger({ requests: 1, input_tokens: 100, output_tokens: 100, cost_usd: 1, wall_time_ms: 1000 });
  ledger.record('task-a', { input_tokens: 10, output_tokens: 10, cost_usd: 0.1, wall_time_ms: 1 }, { requests: 1 });
  assert.throws(() => ledger.record('task-a', {}), error => error.code === 'global_requests_budget');
});

test('structured schema validation reports exact paths', () => {
  const schema = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
  assert.equal(validateStructuredOutput({ answer: 'ok' }, schema).valid, true);
  const invalid = validateStructuredOutput({ answer: 2, extra: true }, schema);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes('$.answer must be string'));
  assert.ok(invalid.errors.includes('$.extra is not allowed'));
});

test('router repairs structured output with a bounded second call', async () => {
  const d = deterministic();
  let calls = 0;
  const router = createModelRouter({
    providers: [baseProvider()],
    transports: {
      'provider-a': async packet => {
        calls += 1;
        if (!packet.repair) return { output: { wrong: true }, usage: { input_tokens: 10, output_tokens: 4, cost_usd: 0.01 } };
        return { output: { answer: 'fixed' }, usage: { input_tokens: 12, output_tokens: 4, cost_usd: 0.01 } };
      }
    },
    ...d,
    repair_retries: 1
  });
  const receipt = await router.execute({
    type: 'review',
    id: 'repair',
    output_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
  });
  assert.equal(receipt.output.answer, 'fixed');
  assert.equal(receipt.repairs, 1);
  assert.equal(calls, 2);
});

test('router retries rate limits with exact attempt evidence', async () => {
  const d = deterministic();
  let calls = 0;
  const router = createModelRouter({
    providers: [baseProvider()],
    transports: {
      'provider-a': async () => {
        calls += 1;
        if (calls === 1) throw new MakerModelRouterError('rate_limited', '429 retry later', 429);
        return { output: { ok: true }, usage: { input_tokens: 10, output_tokens: 3, cost_usd: 0.01 } };
      }
    },
    ...d,
    retries: 1
  });
  const receipt = await router.execute({ type: 'summarization', id: 'rate' });
  assert.equal(receipt.output.ok, true);
  assert.equal(receipt.attempts[0].rate_limited, true);
  assert.equal(receipt.attempts.at(-1).outcome, 'success');
});

test('fallback preserves state while preventing provider metadata and secrets from leaking', async () => {
  const d = deterministic();
  const packets = [];
  const providers = [
    baseProvider({ id: 'a', preferences: { operator_rank: 10 }, metadata: { api_key: 'secret-a' } }),
    baseProvider({ id: 'b', preferences: { operator_rank: 0 }, metadata: { token: 'secret-b' } })
  ];
  const router = createModelRouter({
    providers,
    transports: {
      a: async packet => { packets.push(packet); throw new Error('first failed'); },
      b: async packet => { packets.push(packet); return { output: { answer: 'fallback' } }; }
    },
    ...d,
    retries: 0
  });
  const receipt = await router.execute({ type: 'review', id: 'fallback' }, {
    messages: [{ role: 'user', content: 'same state' }],
    context: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }
  });
  assert.equal(receipt.provider.id, 'b');
  assert.deepEqual(packets[0].messages, packets[1].messages);
  const serialized = JSON.stringify(packets);
  assert.ok(!serialized.includes('secret-a'));
  assert.ok(!serialized.includes('secret-b'));
  assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));
});

test('circuit breaker skips a repeatedly failing provider until cooldown', async () => {
  const d = deterministic();
  let aCalls = 0;
  const router = createModelRouter({
    providers: [baseProvider({ id: 'a', preferences: { operator_rank: 10 } }), baseProvider({ id: 'b' })],
    transports: {
      a: async () => { aCalls += 1; throw new Error('boom'); },
      b: async () => ({ output: { ok: true } })
    },
    ...d,
    retries: 0,
    circuit_failures: 1,
    circuit_cooldown_ms: 1000
  });
  await router.execute({ type: 'review', id: 'one' });
  await router.execute({ type: 'review', id: 'two' });
  assert.equal(aCalls, 1);
  d.advance(1001);
  await router.execute({ type: 'review', id: 'three' });
  assert.equal(aCalls, 2);
});

test('independent grader separation excludes the primary provider', async () => {
  const d = deterministic();
  const used = [];
  const router = createModelRouter({
    providers: [baseProvider({ id: 'primary', preferences: { operator_rank: 10 } }), baseProvider({ id: 'grader' })],
    transports: {
      primary: async () => { used.push('primary'); return { output: { answer: 'candidate' } }; },
      grader: async () => { used.push('grader'); return { output: { grade: 'pass' } }; }
    },
    ...d,
    retries: 0
  });
  const primary = await router.execute({ type: 'review', id: 'primary-task' });
  const graded = await router.grade({ id: 'grade-task', output_schema: { type: 'object', required: ['grade'], properties: { grade: { type: 'string' } } } }, {}, primary);
  assert.equal(primary.provider.id, 'primary');
  assert.equal(graded.provider.id, 'grader');
  assert.deepEqual(used, ['primary', 'grader']);
});

test('no providers fails truthfully without fabricating a runtime', async () => {
  const router = createModelRouter({ providers: [], transports: {} });
  await assert.rejects(router.execute({ type: 'coding', id: 'none' }), error => error.code === 'no_provider');
});

test('health snapshots expose degraded/offline state and native admission without secrets', async () => {
  const d = deterministic();
  const router = createModelRouter({
    providers: [baseProvider({ id: 'healthy', metadata: { api_key: 'secret-value' } }), baseProvider({ id: 'offline', health: 'offline' })],
    transports: {},
    ...d
  });
  const health = await router.health();
  assert.equal(health.providers.find(item => item.provider_id === 'offline').selectable, false);
  assert.ok(!JSON.stringify(health).includes('secret-value'));
  assert.match(health.receipt_digest, /^[a-f0-9]{64}$/);
});

test('secret redaction removes key-shaped and token-shaped values', () => {
  const value = redactProviderSecrets({ api_key: 'sk-abcdefghijklmnopqrstuvwxyz', note: 'Bearer abcdefghijklmnopqrstuvwxyz' });
  assert.equal(value.api_key, '[redacted]');
  assert.ok(!value.note.includes('abcdefghijklmnopqrstuvwxyz'));
});

test('route receipts are deterministic in structure and integrity validates', async () => {
  const d = deterministic();
  const router = createModelRouter({
    providers: [baseProvider()],
    transports: { 'provider-a': async () => ({ output: { answer: 'ok' }, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } }) },
    ...d,
    retries: 0
  });
  const receipt = await router.execute({ type: 'review', id: 'integrity' });
  assert.equal(receipt.receipt_digest, receiptDigest({ ...receipt, receipt_digest: undefined }));
  assert.equal(receipt.attempts.at(-1).outcome, 'success');
});
