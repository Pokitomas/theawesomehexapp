import assert from 'node:assert/strict';
import {
  CAPABILITY_FORGE_SCHEMA,
  INSTALL_LEASE_SCHEMA,
  RECEIPT_SCHEMA,
  buildCapabilityForgePlan,
  createTemporaryInstallLease,
  evaluateCapabilityTermination,
  runTemporaryInstallLease
} from '../capability-forge.mjs';

const plan = buildCapabilityForgePlan({
  mode: 'distill',
  request: 'Make Sideways construct a compact capability and integrate it into the phone product.',
  protect: 'Private archive facts remain private.',
  proof: 'The actual phone product passes exact-head hostile witnesses.',
  budget_envelope: 1.3,
  architecture_prior: 'state-space',
  target_runtime: 'phone'
});

assert.equal(plan.schema, CAPABILITY_FORGE_SCHEMA);
assert.equal(plan.intent.mode, 'distill');
assert.equal(plan.budget.envelope, 1.3);
assert.equal(plan.candidates[0].family, 'state-space');
assert.ok(plan.candidates.some(item => item.id === 'compact-transformer-baseline'));
assert.equal(plan.admission.require_cleanup_after_install, true);
assert.equal(plan.intent.lifecycle.at(-1).id, 'clean');

const lease = createTemporaryInstallLease({
  lease_id: 'candidate-1',
  candidate_id: 'selective-state-space-family',
  program: 'ollama',
  install_args: ['pull', 'example/model'],
  cleanup_args: ['rm', 'example/model'],
  budget_cost: .2
});
assert.equal(lease.schema, INSTALL_LEASE_SCHEMA);
assert.equal(lease.isolated, true);
assert.equal(lease.production_target, false);
assert.match(lease.workspace, /sideways-capability-forge/);
assert.throws(() => createTemporaryInstallLease({ lease_id: 'x', candidate_id: 'x', program: 'bash' }), /not allowlisted/);
assert.throws(() => createTemporaryInstallLease({
  lease_id: 'x', candidate_id: 'x', program: 'npm', install_args: ['install', '--prefix=/etc', 'x']
}), /global, user, system/);
assert.throws(() => createTemporaryInstallLease({
  lease_id: 'x', candidate_id: 'x', program: 'npm', install_args: ['install', '-g', 'x']
}), /global, user, system/);
assert.throws(() => createTemporaryInstallLease({
  lease_id: 'x', candidate_id: 'x', program: 'python', install_args: ['/tmp/installer.py']
}), /absolute filesystem paths/);
assert.throws(() => createTemporaryInstallLease({
  lease_id: 'x', candidate_id: 'x', program: 'ollama', install_args: ['pull', 'example/model']
}), /require an explicit cleanup command/);

await assert.rejects(
  runTemporaryInstallLease(lease, { authorization: '' }),
  /explicit operator authorization/
);

const calls = [];
const removed = [];
const executed = await runTemporaryInstallLease(lease, {
  authorization: 'I_ACCEPT_EPHEMERAL_INSTALLS',
  execute: async (program, args, options) => {
    calls.push({ program, args, options });
    return { stdout: `${args[0]} ok`, stderr: '' };
  },
  mkdir: async () => {},
  remove: async target => { removed.push(target); }
});
assert.equal(executed.ok, true);
assert.equal(calls.length, 2);
assert.equal(calls[0].options.shell, false);
assert.equal(calls[0].options.cwd, lease.workspace);
assert.equal(calls[0].options.env.HOME, lease.workspace);
assert.equal(calls[0].options.env.USERPROFILE, lease.workspace);
assert.ok(calls[0].options.env.npm_config_prefix.startsWith(lease.workspace));
assert.ok(calls[0].options.env.PIP_TARGET.startsWith(lease.workspace));
assert.ok(calls[0].options.env.OLLAMA_MODELS.startsWith(lease.workspace));
assert.equal(removed.length, 1);
assert.equal(executed.receipts[0].type, 'temporary-install');
assert.equal(executed.receipts[1].type, 'temporary-cleanup');
assert.equal(executed.receipts[1].ok, true);

const head = 'a'.repeat(40);
const receipts = [
  { schema: RECEIPT_SCHEMA, type: 'crawl', ok: true },
  { schema: RECEIPT_SCHEMA, type: 'architecture-comparison', ok: true },
  { schema: RECEIPT_SCHEMA, type: 'temporary-install', lease_id: 'candidate-1', ok: true, budget_cost: .2 },
  { schema: RECEIPT_SCHEMA, type: 'candidate-evaluation', ok: true, budget_cost: .3 },
  { schema: RECEIPT_SCHEMA, type: 'distillation', ok: true, budget_cost: .3 },
  { schema: RECEIPT_SCHEMA, type: 'product-integration', ok: true },
  { schema: RECEIPT_SCHEMA, type: 'product-proof', ok: true, head_sha: head },
  { schema: RECEIPT_SCHEMA, type: 'temporary-cleanup', lease_id: 'candidate-1', ok: true }
];
const admitted = evaluateCapabilityTermination(plan, receipts);
assert.equal(admitted.ok, true);
assert.equal(admitted.state, 'admitted-product-capability');
assert.equal(admitted.exact_head, head);

const cleanupBlocked = evaluateCapabilityTermination(plan, receipts.filter(item => item.type !== 'temporary-cleanup'));
assert.equal(cleanupBlocked.ok, false);
assert.equal(cleanupBlocked.state, 'cleanup-blocked');

const noProof = evaluateCapabilityTermination(plan, receipts.filter(item => item.type !== 'product-proof'));
assert.equal(noProof.ok, false);
assert.ok(noProof.missing.includes('product-proof'));

const overspent = evaluateCapabilityTermination(plan, [
  ...receipts,
  { schema: RECEIPT_SCHEMA, type: 'candidate-evaluation', ok: true, budget_cost: 2 }
]);
assert.equal(overspent.ok, false);
assert.equal(overspent.state, 'budget-exhausted');

console.log('capability forge contract ok: architecture brawl, isolated installs, distillation, product proof, cleanup, and budget terminate deterministically');
