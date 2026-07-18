import remoteRows from './authority-manifest.remote.mjs';
import workflowProjectionRows from './authority-manifest.workflow-projection.mjs';
import socialCoreRows from './authority-manifest.social-core.mjs';
import socialGovernanceRows from './authority-manifest.social-governance.mjs';

const status = { e: 'enforced', g: 'enforced', d: 'declaration-only' };
const references = values => values.map(([path, ...anchors]) => ({ path, anchors }));
const repairedDenyWitness = references([
  ['scripts/tests/authority-manifest.test.mjs', 'former repair rows bind current focused denial witnesses']
]);
const overrides = {
  'remote.write': {
    replayBoundary: 'Per-principal nonce and message-id uniqueness with one-process mutation serialization. Blob storage does not claim cross-instance atomic compare-and-set.',
    denialConditions: ['authentication failure', 'principal lacks write', 'terminal generation', 'duplicate message id', 'used nonce', 'target mismatch']
  }
};

const persistentCoreWorkflowRow = {
  id: 'workflow.archie-persistent-core', f: 'workflow', op: 'Verify persistent cognition, Archie App admission, and Trainer brain-package authority',
  actor: 'GitHub push, pull-request, or manual actor', principal: 'Read-only GitHub Actions token executing the exact candidate head',
  auth: 'contents:read only', object: 'Check result and local ephemeral working-state fixture', owner: 'Repository CI configuration',
  deny: 'event or path filter does not match|checkout or dependency setup fails|persistent cognition tests fail|promptless cycle receipt is malformed',
  replay: 'Exact workflow run, pull-request head SHA, test command, and promptless cycle receipt.',
  pub: 'Public check status and test names.', priv: 'Ephemeral runner working state is discarded; no secrets or durable Trainer key are consumed.', st: 'e',
  s: ['workflow-permission:.github/workflows/archie-persistent-core.yml:contents:read'],
  impl: [['.github/workflows/archie-persistent-core.yml', 'contents: read', 'persist-credentials: false', 'npm run test:archie:persistent', 'Exercise promptless no-op cycle']],
  allow: [['scripts/tests/maker-archie-persistent-core.test.mjs', 'persistent cognition can cycle without a prompt and truthfully choose no-op']],
  denyW: [['scripts/tests/maker-archie-persistent-core.test.mjs', 'external effects fail closed without explicit runtime authority']]
};

const nativeIPhoneWorkflowRow = {
  id: 'workflow.archie-native-iphone', f: 'workflow', op: 'Generate, compile, and test the fail-closed native Archie iPhone runtime',
  actor: 'GitHub push, pull-request, or manual actor', principal: 'Read-only GitHub Actions token executing the exact candidate head on a hosted macOS runner',
  auth: 'contents:read only', object: 'Generated Xcode project, simulator build, unit-test result bundle, and diagnostic artifact', owner: 'Repository CI configuration',
  deny: 'event or path filter does not match|checkout or XcodeGen setup fails|project generation fails|no iPhone simulator is available|native build or tests fail',
  replay: 'Exact workflow run, pull-request head SHA, hosted runner image, generated project, xcodebuild command, log, and result bundle.',
  pub: 'Public check status, concise compiler failures, and bounded diagnostic artifacts.', priv: 'No signing identity, model artifact, production data, or deployment credential is consumed.', st: 'e',
  s: ['workflow-permission:.github/workflows/archie-ios-runtime.yml:contents:read'],
  impl: [['.github/workflows/archie-ios-runtime.yml', 'contents: read', 'persist-credentials: false', 'xcodegen generate', 'xcodebuild test', 'CODE_SIGNING_ALLOWED=NO']],
  allow: [['ios/ArchiePhone/Tests/ModelManifestTests.swift', 'testAcceptsExactDigestBoundManifest']],
  denyW: [['ios/ArchiePhone/Tests/ModelManifestTests.swift', 'testRejectsWeakRevisionAndWrongABI']]
};

const fullVersionWorkflowRow = {
  id: 'workflow.archie-full-version', f: 'workflow', op: 'Verify the complete local, hosted, hybrid, compatibility, distillation, and repository-completion contract set',
  actor: 'GitHub push, pull-request, or manual actor', principal: 'Read-only GitHub Actions token executing the exact candidate head on a hosted Ubuntu runner',
  auth: 'contents:read only', object: 'Ephemeral checkout, test outputs, and a bounded full-version gate receipt artifact', owner: 'Repository CI configuration',
  deny: 'event or path filter does not match|checkout or dependency setup fails|syntax check fails|workspace, distillation, or repository-completion contract fails|gate receipt cannot be emitted',
  replay: 'Exact workflow run, candidate SHA, pinned actions, Node version, invoked package scripts, and uploaded full-version receipt.',
  pub: 'Public check status, test names, and bounded full-version receipt artifact.', priv: 'Ephemeral runner files are discarded; no write token, deployment credential, model promotion key, or external account authority is consumed.', st: 'e',
  s: ['workflow-permission:.github/workflows/archie-full-version.yml:contents:read'],
  impl: [['.github/workflows/archie-full-version.yml', 'contents: read', 'persist-credentials: false', 'npm run test:archie:workspace', 'npm run test:archie:distill', 'npm run test:archie:repository-completion']],
  allow: [['scripts/tests/archie-repository-completion.test.mjs', 'runs a writer only in the isolated clone and emits a verified patch']],
  denyW: [['scripts/tests/archie-repository-completion.test.mjs', 'prepares an exact read-only clone without touching the source']]
};

const cudaTrainingWorkflowRow = {
  id: 'workflow.archie-cuda-training', f: 'workflow', op: 'Authorize and execute verifier-anchored causal-divergence CUDA QLoRA training or emit a pre-queue blocker',
  actor: 'Repository owner pushing a bound request to main or manually dispatching; pull requests execute contract checks only',
  principal: 'Read-only GitHub Actions token for checkout and a bounded issues:write token for terminal receipts; real training runs only on an explicitly labeled self-hosted CUDA runner',
  auth: 'contents:read and issues:write; repository-owner actor, ARCHIE_CUDA_RUNNER_READY=1, configured runner label, exact Python, compiler config, admitted trajectory batch, student checkpoint, and output root are mandatory before queue',
  object: 'Authorization or blocker artifact, issue receipt, local compiled workspace, causal pair receipt, QLoRA adapter/checkpoints, runner evidence, logs, and non-admitted training receipts',
  owner: 'Repository owner controls request and variables; self-hosted runner operator controls GPU and local model/data inputs; admission remains independently governed',
  deny: 'pull request cannot enter training lane|actor is not repository owner|required variable is missing|readiness flag is not one|runner label is unavailable|CUDA or VRAM preflight fails|pinned dependency or local input is missing|trajectory batch or pair compilation fails|compiler or trainer fails|receipt is missing artifacts or attempts promotion',
  replay: 'Request ID, issue number, exact code SHA, Actions run and attempt, runner identity, GPU identity, profile/config/trajectory/trainer/compiler digests, pair receipt, compiled plan, sample order, checkpoint identity, output bytes, and both training receipt digests.',
  pub: 'Workflow status, bounded issue comments, blocker metadata, and artifact names are public.',
  priv: 'Local model weights, reviewed trajectory batches, compiled preference rows, compiler config contents, runner filesystem paths beyond bounded receipts, registration tokens, and GitHub token remain private.', st: 'e',
  s: [
    'workflow-permission:.github/workflows/archie-cuda-training.yml:contents:read',
    'workflow-permission:.github/workflows/archie-cuda-training.yml:issues:write'
  ],
  impl: [[
    '.github/workflows/archie-cuda-training.yml',
    'permissions:',
    'contents: read',
    'issues: write',
    'ARCHIE_CUDA_RUNNER_READY',
    'ARCHIE_TRAJECTORY_BATCH_PATH',
    'foundry/archie-distill/compile_causal_pairs.py',
    'foundry/archie-distill/train_causal_divergence.py',
    'No training job was queued. Missing configuration is a blocker',
    'runs-on: [self-hosted, linux, x64, "${{ vars.ARCHIE_CUDA_RUNNER_LABEL }}"]',
    "'promotion': 'not-admitted'"
  ]],
  allow: [['.github/workflows/archie-cuda-training.yml', 'A real causal-divergence CUDA QLoRA run produced uploaded artifacts']],
  denyW: [['.github/workflows/archie-cuda-training.yml', 'No GPU job, gradient update, checkpoint, or training receipt was produced.']]
};

const compatibilityMigrationWorkflowRow = {
  id: 'workflow.archie-compatibility-migration', f: 'workflow', op: 'Verify exact legacy import and source-host authority inventory',
  actor: 'GitHub push, pull-request, or manual actor', principal: 'Read-only GitHub Actions token executing the exact candidate head across the operating-system and Node matrix',
  auth: 'contents:read only', object: 'Compatibility-import and source-host-inventory check results', owner: 'Repository CI configuration',
  deny: 'event or path filter does not match|checkout or dependency setup fails|compatibility migration tests fail',
  replay: 'Exact workflow run, pull-request head SHA, operating-system and Node matrix cell, and test command.',
  pub: 'Public check status and test names.', priv: 'Ephemeral fixtures are discarded; no secrets or source-host mutation authority are consumed.', st: 'e',
  s: ['workflow-permission:.github/workflows/archie-compatibility-migration.yml:contents:read'],
  impl: [['.github/workflows/archie-compatibility-migration.yml', 'contents: read', 'persist-credentials: false', 'node --test scripts/tests/archie-compatibility-migration.test.mjs']],
  allow: [['scripts/tests/archie-compatibility-migration.test.mjs', 'source-host inventory separates canonical runtime blockers from adapters, CI, tests, and documentation']],
  denyW: [['scripts/tests/archie-compatibility-migration.test.mjs', 'source-host inventory reports deletion readiness only after blockers are absent']]
};

const liteWorkflowRow = {
  id: 'workflow.archie-lite', f: 'workflow', op: 'Verify bounded GGUF inspection, RAM-capped context planning, and CPU-only Archie execution authority',
  actor: 'GitHub push, pull-request, or manual actor', principal: 'Read-only GitHub Actions token executing the exact candidate head across the operating-system and Node matrix',
  auth: 'contents:read only', object: 'Low-compute syntax, metadata parser, RAM planner, CPU enforcement, package aliases, and CLI-help check results', owner: 'Repository CI configuration',
  deny: 'event or path filter does not match|checkout or dependency setup fails|syntax check fails|low-compute contract tests fail|operator help fails',
  replay: 'Exact workflow run, pull-request head SHA, operating-system and Node matrix cell, Node version, test command, and CLI-help command.',
  pub: 'Public check status and test names.', priv: 'Ephemeral GGUF fixtures and Archie homes are discarded; no model weights, prompts, credentials, accelerator authority, or external service access are consumed.', st: 'e',
  s: ['workflow-permission:.github/workflows/archie-lite.yml:contents:read'],
  impl: [['.github/workflows/archie-lite.yml', 'contents: read', 'persist-credentials: false', 'npm run test:archie:lite', 'node scripts/archie-lite.mjs --help']],
  allow: [['scripts/tests/maker-archie-lite.test.mjs', 'installed GGUF planning binds metadata, RAM cap, CPU authority, and a durable receipt']],
  denyW: [['scripts/tests/maker-archie-lite.test.mjs', 'CPU execution disables model, KV, op, projector, and auto-fit offload paths']]
};

const rows = [
  ...remoteRows,
  ...workflowProjectionRows,
  persistentCoreWorkflowRow,
  nativeIPhoneWorkflowRow,
  fullVersionWorkflowRow,
  cudaTrainingWorkflowRow,
  compatibilityMigrationWorkflowRow,
  liteWorkflowRow,
  ...socialCoreRows,
  ...socialGovernanceRows
].map(row => ({
  id: row.id,
  family: row.f,
  operation: row.op,
  originActor: row.actor,
  principalSource: row.principal,
  requiredAuthority: row.auth,
  mutableObject: row.object,
  authorityOwner: row.owner,
  denialConditions: overrides[row.id]?.denialConditions || row.deny.split('|'),
  replayBoundary: overrides[row.id]?.replayBoundary || row.replay,
  residue: { public: row.pub, private: row.priv },
  status: status[row.st],
  surfaces: row.s,
  implementation: references(row.impl),
  allowWitness: references(row.allow),
  denyWitness: row.st === 'g' ? repairedDenyWitness : references(row.denyW)
}));

export default {
  schemaVersion: 1,
  purpose: 'Executable authority inventory for current repository truth after executive convergence. Every in-repository authority surface is enforced or explicitly declaration-only; this manifest is audit evidence, not runtime authority.',
  externalUnknowns: [
    'GitHub branch protection and required checks',
    'GitHub environment protection',
    'Installed GitHub App grants',
    'Repository and environment secret values',
    'GitHub Pages deployment settings',
    'Netlify team roles, deploy contexts, and secret grants',
    'PostgreSQL role grants outside repository migrations'
  ],
  rows
};
