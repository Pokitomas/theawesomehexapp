import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../archie-launch-contract.mjs';
import {
  ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA,
  runDeviceEvidenceCampaign,
  validateDeviceEvidenceCampaign
} from '../archie-device-evidence.mjs';

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function descriptor(filename, relative = null) {
  const stat = await fs.stat(filename);
  return { path: relative || filename, bytes: stat.size, sha256: await hashFile(filename) };
}

function machine() {
  const hardware = {
    device_class: 'test-workstation',
    architecture: process.arch,
    cpu_threads: 8,
    ram_bytes: 16_000_000_000,
    vram_bytes: 4_000_000_000,
    disk_free_bytes: 100_000_000_000,
    accelerators: ['test-gpu'],
    energy_watts_budget: 300,
    thermal_celsius_limit: 95
  };
  const operating_system = {
    family: process.platform,
    version: 'test-version',
    background_model: 'process-and-service',
    sandbox: 'test-sandbox'
  };
  const hardware_fingerprint = digest(hardware);
  const os_fingerprint = digest(operating_system);
  return {
    id: 'test-machine',
    hardware,
    operating_system,
    hardware_fingerprint,
    os_fingerprint,
    device_fingerprint: digest({ hardware_fingerprint, os_fingerprint }),
    permissions: { microphone: true },
    network_available: false
  };
}

const adapterSource = String.raw`import crypto from 'node:crypto';
import fs from 'node:fs/promises';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const input = JSON.parse(await new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => resolve(text)); }));
const mode = process.argv[2] || 'pass';
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
const started = new Date();
const evidenceBytes = Buffer.from('real-device-evidence:' + mode + ':' + input.nonce);
await fs.writeFile('probe-evidence.bin', evidenceBytes);
const eventIds = mode === 'missing-event' ? input.required_events.slice(0, -1) : input.required_events;
const events = eventIds.map((id, index) => ({ id, at: new Date(started.getTime() + index).toISOString(), evidence_digest: digest({ id, nonce: input.nonce }) }));
const body = {
  schema: 'archie-real-device-probe-result/v1',
  campaign_id: input.campaign_id,
  campaign_digest: input.campaign_digest,
  probe_id: input.probe_id,
  device_fingerprint: input.device_fingerprint,
  nonce: mode === 'bad-nonce' ? '0'.repeat(64) : input.nonce,
  completed: true,
  real_device: true,
  mock: mode === 'mock',
  promotion_eligible: true,
  started_at: started.toISOString(),
  ended_at: new Date().toISOString(),
  events,
  permissions: { microphone: { granted: true, evidence_digest: digest({ permission: 'microphone', nonce: input.nonce }) } },
  revocation_checks: mode === 'no-revoke' ? [] : [{ permission: 'microphone', revoked: true, subsequent_access_denied: true, evidence_digest: digest({ revoked: 'microphone', nonce: input.nonce }) }],
  metrics: { interaction_success_rate: mode === 'impossible-rate' ? 4 : 1, p95_interaction_latency_ms: 40 },
  resource_cost: { ram_bytes: 64_000_000, cpu_threads: 1, energy_watts: 8 },
  artifacts: [{ path: 'probe-evidence.bin', bytes: evidenceBytes.length, sha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex') }]
};
process.stdout.write(JSON.stringify({ ...body, result_digest: digest(body) }));
`;

async function fixture(mode = 'pass', { timeout_ms = 5_000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-device-evidence-'));
  const adapter = path.join(root, 'probe-adapter.mjs');
  await fs.writeFile(adapter, adapterSource);
  const nodeDescriptor = await descriptor(process.execPath);
  const adapterDescriptor = await descriptor(adapter, 'probe-adapter.mjs');
  const campaign = {
    schema: ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA,
    id: `device-campaign-${mode}`,
    machine: machine(),
    probes: [{
      id: 'spoken-companion-probe',
      capability_id: 'spoken-companion-device',
      required_for_launch: true,
      families: ['interaction-adapter'],
      faculties: ['audio-input', 'audio-output', 'duplex-turn-taking', 'streaming-response'],
      required_events: ['microphone-opened', 'audio-frame-captured', 'transcript-produced', 'audio-output-started', 'interruption-detected', 'audio-output-stopped'],
      required_permissions: ['microphone'],
      revocation_permissions: ['microphone'],
      network: 'none',
      requires: [],
      conflicts: [],
      gates: { interaction_success_rate_min: 0.95, p95_interaction_latency_ms_max: 1500 },
      minimum_resources: { ram_bytes: 32_000_000, cpu_threads: 1 },
      command: {
        executable: nodeDescriptor,
        args: ['probe-adapter.mjs', mode],
        bound_files: [adapterDescriptor],
        cwd: '.',
        timeout_ms,
        pass_environment: []
      }
    }],
    claim_boundary: 'Test campaign only.'
  };
  return { root, adapter, campaign };
}

test('fresh hash-bound real-device execution admits a compatible launch capability', async t => {
  const { root, campaign } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evidence = await runDeviceEvidenceCampaign(campaign, { root });
  assert.equal(evidence.decision, 'admitted-real-device-evidence');
  assert.deepEqual(evidence.admitted_capability_ids, ['spoken-companion-device']);
  assert.equal(evidence.capabilities[0].status, 'admitted');
  assert.equal(evidence.capabilities[0].metrics.interaction_success_rate, 1);
  assert.ok(evidence.capabilities[0].evidence_digests.length >= 4);
  assert.match(evidence.package_digest, /^[a-f0-9]{64}$/);
});

test('missing ordered device events cannot admit the claimed faculties', async t => {
  const { root, campaign } = await fixture('missing-event');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evidence = await runDeviceEvidenceCampaign(campaign, { root });
  assert.equal(evidence.decision, 'rejected-real-device-evidence');
  assert.equal(evidence.capabilities[0].status, 'absent');
  assert.ok(evidence.capabilities[0].blockers.includes('required-event-order'));
});

test('mock output, nonce replay, and missing revocation receipts fail closed', async t => {
  for (const [mode, blocker] of [['mock', 'not-mock'], ['bad-nonce', 'nonce-bound'], ['no-revoke', 'revocation:microphone']]) {
    const { root, campaign } = await fixture(mode);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const evidence = await runDeviceEvidenceCampaign(campaign, { root });
    assert.equal(evidence.decision, 'rejected-real-device-evidence');
    assert.ok(evidence.capabilities[0].blockers.includes(blocker), `${mode} should include ${blocker}`);
  }
});

test('adapter mutation is rejected before execution', async t => {
  const { root, adapter, campaign } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(adapter, '\n// mutation\n');
  const evidence = await runDeviceEvidenceCampaign(campaign, { root });
  assert.equal(evidence.decision, 'rejected-real-device-evidence');
  assert.equal(evidence.probes[0].execution, null);
  assert.match(evidence.capabilities[0].blockers[0], /^command-integrity:/);
});

test('timeouts and impossible rate metrics cannot create evidence', async t => {
  const slow = await fixture('slow', { timeout_ms: 100 });
  t.after(() => fs.rm(slow.root, { recursive: true, force: true }));
  const timedOut = await runDeviceEvidenceCampaign(slow.campaign, { root: slow.root });
  assert.equal(timedOut.decision, 'rejected-real-device-evidence');
  assert.ok(timedOut.capabilities[0].blockers.includes('execution-timeout'));

  const impossible = await fixture('impossible-rate');
  t.after(() => fs.rm(impossible.root, { recursive: true, force: true }));
  const rejected = await runDeviceEvidenceCampaign(impossible.campaign, { root: impossible.root });
  assert.equal(rejected.decision, 'rejected-real-device-evidence');
  assert.match(rejected.capabilities[0].blockers[0], /^result-invalid:/);
});

test('campaign validation rejects hidden dependencies and secret-bearing environment passthrough', async t => {
  const { root, campaign } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hiddenDependency = structuredClone(campaign);
  hiddenDependency.probes[0].requires = ['missing-capability'];
  assert.throws(() => validateDeviceEvidenceCampaign(hiddenDependency), /requires unknown capability/);
  const secretEnvironment = structuredClone(campaign);
  secretEnvironment.probes[0].command.pass_environment = ['OPENAI_API_KEY'];
  assert.throws(() => validateDeviceEvidenceCampaign(secretEnvironment), /secret-like variable/);
});
