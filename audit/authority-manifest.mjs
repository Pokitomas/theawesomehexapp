import remoteRows from './authority-manifest.remote.mjs';
import workflowProjectionRows from './authority-manifest.workflow-projection.mjs';
import socialCoreRows from './authority-manifest.social-core.mjs';
import socialGovernanceRows from './authority-manifest.social-governance.mjs';

const status = { e: 'enforced', g: 'enforced', d: 'declaration-only' };
const references = values => values.map(([path, ...anchors]) => ({ path, anchors }));
const overrides = {
  'remote.write': {
    replayBoundary: 'Per-principal nonce and message-id uniqueness with one-process mutation serialization. Blob storage does not claim cross-instance atomic compare-and-set.',
    denialConditions: ['authentication failure', 'principal lacks write', 'terminal generation', 'duplicate message id', 'used nonce', 'target mismatch']
  }
};

const rows = [
  ...remoteRows,
  ...workflowProjectionRows,
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
  denyWitness: references(row.denyW)
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
