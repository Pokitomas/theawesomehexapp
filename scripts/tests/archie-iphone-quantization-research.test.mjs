import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest as launchDigest } from '../archie-launch-contract.mjs';
import {
  ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA,
  CANONICAL_IPHONE_DESIGNS,
  CANONICAL_IPHONE_DESIGNS_DIGEST,
  CANONICAL_IPHONE_TARGET,
  CANONICAL_IPHONE_TARGET_DIGEST,
  digest,
  evaluateIPhoneResearch,
  validateIPhoneResearchPlan
} from '../archie-iphone-quantization-research.mjs';

async function descriptor(root, relative) {
  const filename = path.join(root, relative); const data = await fs.readFile(filename);
  return { path: relative, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length };
}
function machine(version = '18.5 22F76') {
  const hardware = { device_class: 'iphone14,6', architecture: 'arm64', cpu_threads: 6, ram_bytes: 4 * 1024 ** 3, vram_bytes: 0, disk_free_bytes: 20 * 1024 ** 3, accelerators: ['apple-a15'], energy_watts_budget: 6, thermal_celsius_limit: 45 };
  const operating_system = { family: 'ios', version, background_model: 'foreground-with-explicit-background-task', sandbox: 'ios-application-sandbox' };
  const hardware_fingerprint = launchDigest(hardware); const os_fingerprint = launchDigest(operating_system);
  return { id: 'iphone-floor-fixture', hardware, operating_system, hardware_fingerprint, os_fingerprint, device_fingerprint: launchDigest({ hardware_fingerprint, os_fingerprint }), permissions: {}, network_available: false };
}
const adapter = String.raw`import crypto from 'node:crypto'; import fs from 'node:fs/promises';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const input=JSON.parse(await new Promise(resolve=>{let t='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>resolve(t));}));
const started=new Date(); const trace=Buffer.from('fresh:'+input.nonce); await fs.writeFile('trace.bin',trace);
const body={schema:'archie-real-device-probe-result/v1',campaign_id:input.campaign_id,campaign_digest:input.campaign_digest,probe_id:input.probe_id,device_fingerprint:input.device_fingerprint,nonce:input.nonce,completed:true,real_device:true,mock:false,promotion_eligible:true,started_at:started.toISOString(),ended_at:new Date().toISOString(),events:input.required_events.map((id,i)=>({id,at:new Date(started.getTime()+i).toISOString(),evidence_digest:digest({id,nonce:input.nonce})})),permissions:{},revocation_checks:[],metrics:{artifact_bytes:1800000000,peak_rss_bytes:2400000000,context_tokens:4096,quality_retention:0.97,task_success_rate:0.9,crash_rate:0,first_token_ms_p95:1200,decode_ms_per_token_p95:85,sustained_tokens_per_second_p50:11,sustained_power_watts_p95:4.8,thermal_throttle_rate:0.02,sustained_duration_ms:1000000,sample_count:50},resource_cost:{ram_bytes:2400000000,energy_watts:4.8},artifacts:[{path:'trace.bin',bytes:trace.length,sha256:crypto.createHash('sha256').update(trace).digest('hex')}]};
process.stdout.write(JSON.stringify({...body,result_digest:digest(body)}));`;

async function fixture({ osVersion = '18.5 22F76' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-iphone-v2-'));
  await fs.copyFile(process.execPath, path.join(root, 'runtime-node')); await fs.chmod(path.join(root, 'runtime-node'), 0o755);
  await fs.writeFile(path.join(root, 'probe.mjs'), adapter); await fs.writeFile(path.join(root, 'model.bin'), Buffer.alloc(1024, 1)); await fs.writeFile(path.join(root, 'benchmark.json'), '{"hidden":true}\n');
  const runtime = await descriptor(root, 'runtime-node'); const model = await descriptor(root, 'model.bin'); const corpus = await descriptor(root, 'benchmark.json'); const probe = await descriptor(root, 'probe.mjs');
  const design = CANONICAL_IPHONE_DESIGNS.find(value => value.id === 'mlx-q4-g32');
  const candidateBase = { id: 'candidate-one', design_id: design.id, model: { id: 'archie-student', revision_sha256: 'a'.repeat(64), artifact: model }, runtime: { id: 'native-test-runtime', executable: runtime, build_sha256: 'b'.repeat(64), dependency_lock_sha256: 'c'.repeat(64), compiler_receipt_sha256: 'd'.repeat(64) }, benchmark: { hidden_split_sha256: 'e'.repeat(64), grader_sha256: 'f'.repeat(64), workload_set_sha256: '1'.repeat(64), corpus }, authority_id: 'physical-lab-one' };
  const bindings = { candidate_id: candidateBase.id, design_id: design.id, design_digest: digest(design), model_id: candidateBase.model.id, model_revision_sha256: candidateBase.model.revision_sha256, model_artifact_sha256: model.sha256, runtime_id: candidateBase.runtime.id, runtime_executable_sha256: runtime.sha256, runtime_build_sha256: candidateBase.runtime.build_sha256, dependency_lock_sha256: candidateBase.runtime.dependency_lock_sha256, compiler_receipt_sha256: candidateBase.runtime.compiler_receipt_sha256, hidden_split_sha256: candidateBase.benchmark.hidden_split_sha256, grader_sha256: candidateBase.benchmark.grader_sha256, workload_set_sha256: candidateBase.benchmark.workload_set_sha256, target_digest: CANONICAL_IPHONE_TARGET_DIGEST, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST };
  await fs.writeFile(path.join(root, 'binding.json'), `${JSON.stringify(bindings)}\n`); const binding = await descriptor(root, 'binding.json');
  const gates = { artifact_bytes_max: CANONICAL_IPHONE_TARGET.maximum_artifact_bytes, peak_rss_bytes_max: CANONICAL_IPHONE_TARGET.maximum_peak_rss_bytes, context_tokens_min: CANONICAL_IPHONE_TARGET.minimum_context_tokens, quality_retention_min: CANONICAL_IPHONE_TARGET.minimum_quality_retention, task_success_rate_min: CANONICAL_IPHONE_TARGET.minimum_task_success_rate, crash_rate_max: CANONICAL_IPHONE_TARGET.maximum_crash_rate, first_token_ms_p95_max: CANONICAL_IPHONE_TARGET.maximum_first_token_ms_p95, decode_ms_per_token_p95_max: CANONICAL_IPHONE_TARGET.maximum_decode_ms_per_token_p95, sustained_tokens_per_second_p50_min: CANONICAL_IPHONE_TARGET.minimum_sustained_tokens_per_second_p50, sustained_power_watts_p95_max: CANONICAL_IPHONE_TARGET.maximum_sustained_power_watts_p95, thermal_throttle_rate_max: CANONICAL_IPHONE_TARGET.maximum_thermal_throttle_rate, sustained_duration_ms_min: CANONICAL_IPHONE_TARGET.minimum_sustained_duration_ms, sample_count_min: CANONICAL_IPHONE_TARGET.minimum_sample_count };
  const campaign = { schema: 'archie-real-device-evidence-campaign/v1', id: 'iphone-candidate-one', machine: machine(osVersion), probes: [{ id: 'iphone-runtime-probe', capability_id: 'archie-iphone-candidate:candidate-one', required_for_launch: true, families: ['native-model-runtime'], faculties: ['answer','planning','tool-routing'], required_events: CANONICAL_IPHONE_TARGET.required_events, required_permissions: [], revocation_permissions: [], network: 'none', requires: [], conflicts: [], gates, minimum_resources: {}, command: { executable: runtime, args: ['probe.mjs'], bound_files: [binding, model, corpus, probe], cwd: '.', timeout_ms: 10000, pass_environment: [] } }], claim_boundary: 'Synthetic fixture; independent authority remains absent.' };
  await fs.writeFile(path.join(root, 'campaign.json'), `${JSON.stringify(campaign, null, 2)}\n`); const evidence_campaign = await descriptor(root, 'campaign.json');
  const candidate = { ...candidateBase, binding_file: binding, evidence_campaign };
  const plan = { schema: ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA, id: 'iphone-plan', target_digest: CANONICAL_IPHONE_TARGET_DIGEST, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST, candidates: [candidate], claim_boundary: 'Test only.' };
  await fs.writeFile(path.join(root, 'authorities.json'), '{"schema":"archie-iphone-measurement-authorities/v1","authorities":[]}\n');
  return { root, plan };
}

const options = root => ({ root, authorityManifestPath: path.join(root, 'authorities.json') });

test('plans cannot weaken the canonical target, thresholds, workloads, or design matrix', async t => {
  const { root, plan } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => validateIPhoneResearchPlan(plan));
  assert.throws(() => validateIPhoneResearchPlan({ ...plan, target_digest: '0'.repeat(64) }), /immutable repository target/);
  assert.throws(() => validateIPhoneResearchPlan({ ...plan, thresholds: { sample_count: 1 } }), /cannot redefine/);
  const unknown = structuredClone(plan); unknown.candidates[0].design_id = 'mlx-q4.5-g17'; assert.throws(() => validateIPhoneResearchPlan(unknown), /canonical search matrix/);
  assert.ok(CANONICAL_IPHONE_DESIGNS.some(value => value.id === 'coreml-pal8-g16'));
  assert.ok(CANONICAL_IPHONE_DESIGNS.filter(value => value.backend === 'gguf').length >= 4);
});

test('fresh nonce-bound synthetic evidence still cannot select without an enrolled independent authority', async t => {
  const { root, plan } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await evaluateIPhoneResearch(plan, options(root));
  assert.equal(result.decision, 'no-iphone-candidate-admitted'); assert.equal(result.selected_candidate, null);
  assert.match(result.evaluations[0].evidence_package_digest, /^[a-f0-9]{64}$/);
  assert.ok(result.evaluations[0].blockers.includes('independent-measurement-authority-required'));
});

test('mutated artifacts and replayed model revisions fail closed', async t => {
  const { root, plan } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(root, 'model.bin'), 'mutation');
  let result = await evaluateIPhoneResearch(plan, options(root)); assert.match(result.evaluations[0].blockers[0], /model\.artifact byte count mismatch/);
  const fresh = await fixture(); t.after(() => fs.rm(fresh.root, { recursive: true, force: true }));
  const replay = structuredClone(fresh.plan); replay.candidates[0].model.revision_sha256 = '9'.repeat(64);
  result = await evaluateIPhoneResearch(replay, options(fresh.root)); assert.match(result.evaluations[0].blockers[0], /binding file does not match/);
});

test('exact iOS build identity is required', async t => {
  const { root, plan } = await fixture({ osVersion: '18.5' }); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await evaluateIPhoneResearch(plan, options(root)); assert.match(result.evaluations[0].blockers[0], /exact iOS version and build number/);
});
