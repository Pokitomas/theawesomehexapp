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
const archieDistillingWorkflowRow = {
  id: 'workflow.archie-distilling-chamber',
  f: 'workflow',
  op: 'Run bounded CPU-first Archie practice episodes and preserve a non-secret smoke receipt',
  actor: 'GitHub pull-request or manual workflow actor',
  principal: 'Read-only GitHub Actions token executing exact candidate code',
  auth: 'contents:read only; no repository mutation, provider, model, or secret authority',
  object: 'Check result and bounded chamber smoke artifact',
  owner: 'GitHub repository CI configuration; admission and deployment remain separate human-controlled operations',
  deny: 'event or path filter does not match|checkout or Node setup fails|syntax, contract, focused test, or smoke execution fails|artifact is absent',
  replay: 'Exact workflow run, candidate commit, ordered chamber events, and retained smoke artifact.',
  pub: 'Workflow status and intentionally uploaded non-secret smoke receipt are public.',
  priv: 'No credentials, provider secrets, model weights, or private corpus records are consumed.',
  st: 'e',
  s: ['workflow-permission:.github/workflows/archie-linux-distilling-chamber.yml:contents:read'],
  impl: [['.github/workflows/archie-linux-distilling-chamber.yml', 'contents: read', 'persist-credentials: false', 'Run focused tests', 'Upload truthful smoke receipt']],
  allow: [['scripts/tests/archie-distilling-chamber.test.mjs', 'event stream is ordered, cursor-resumable, and deterministic in shape'], ['scripts/tests/archie-distilling-chamber.test.mjs', 'checkpoint is digest-bound and restart evidence is serializable']],
  denyW: [['scripts/tests/archie-distilling-chamber.test.mjs', 'repeated states are rejected instead of looping'], ['scripts/tests/archie-distilling-chamber.test.mjs', 'child and depth budgets are enforced'], ['scripts/tests/archie-distilling-chamber.test.mjs', 'pause, resume, and stop are truthful']]
};

const rows = [
  ...remoteRows,
  ...workflowProjectionRows,
  archieDistillingWorkflowRow,
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
