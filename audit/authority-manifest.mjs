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

const rows = [
  ...remoteRows,
  ...workflowProjectionRows,
  persistentCoreWorkflowRow,
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
