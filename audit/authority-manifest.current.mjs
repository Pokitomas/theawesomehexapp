import baseManifest from './authority-manifest.mjs';

const references = values => values.map(([path, ...anchors]) => ({ path, anchors }));

const researchWorkflowRows = [
  {
    id: 'workflow.archie-research-read-only',
    family: 'workflow',
    operation: 'Export, train, verify, and package Archie research candidates without repository mutation authority',
    originActor: 'GitHub push, pull-request, or explicit workflow-dispatch actor',
    principalSource: 'Read-only GitHub Actions token executing an exact candidate checkout',
    requiredAuthority: 'contents:read only for source and verification workflows; no repository write authority',
    mutableObject: 'Ephemeral runner files, digest-bound evidence bundles, and uploaded research artifacts',
    authorityOwner: 'Repository CI configuration; admission remains governed separately',
    denialConditions: [
      'event or path filter does not match',
      'checkout, materialization, compilation, training, evaluation, or artifact publication fails',
      'evidence verification fails',
      'candidate attempts admission or production mutation'
    ],
    replayBoundary: 'Exact workflow run, candidate and merge SHA, pinned actions, source and artifact digests, optimizer budget, frozen evaluation suites, and terminal promotion state.',
    residue: {
      public: 'Public check status, bounded summaries, artifact names, and cryptographic digests.',
      private: 'Ephemeral runner state and GitHub token are discarded; no production credential or model-promotion authority is consumed.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie-campaign-source-export-v2.yml:contents:read',
      'workflow-permission:.github/workflows/archie-causal-mechanism-full-budget.yml:contents:read',
      'workflow-permission:.github/workflows/archie-generalized-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-latent-world-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-productize-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-productize-winner.yml:contents:read',
      'workflow-permission:.github/workflows/archie-radial-mechanism-probe.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:contents:read',
      'workflow-permission:.github/workflows/archie-terminal-efficiency-v3.yml:contents:read',
      'workflow-permission:.github/workflows/archie-typed-program-freeze-v3.yml:contents:read',
      'workflow-permission:.github/workflows/archie-typed-program-student.yml:contents:read'
    ],
    implementation: references([
      ['.github/workflows/archie-causal-mechanism-full-budget.yml', 'permissions:', 'contents: read', 'Independently verify evidence bundle'],
      ['.github/workflows/archie-productize-winner.yml', 'contents: read', 'shadow-product-not-admitted'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'contents: read', 'promotion'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'contents: read', 'promotion'],
      ['.github/workflows/archie-typed-program-student.yml', 'contents: read', 'promotion']
    ]),
    allowWitness: references([
      ['scripts/tests/supply-chain-contract.test.mjs', 'read-only proof workflows disable persisted checkout credentials']
    ]),
    denyWitness: references([
      ['.github/workflows/archie-productize-winner.yml', 'promotion'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'not-admitted']
    ])
  },
  {
    id: 'workflow.archie-research-artifact-read',
    family: 'workflow',
    operation: 'Read immutable GitHub Actions artifacts for independent admission and continuation evaluation',
    originActor: 'GitHub pull-request or explicit workflow-dispatch actor',
    principalSource: 'GitHub Actions token scoped to actions:read and contents:read',
    requiredAuthority: 'actions:read only for downloading named prior-run artifacts',
    mutableObject: 'Ephemeral copies of immutable workflow artifacts',
    authorityOwner: 'GitHub Actions artifact service and repository CI configuration',
    denialConditions: [
      'source run is absent or incomplete',
      'artifact cannot be downloaded',
      'artifact digest or independent verification fails',
      'workflow attempts to mutate a prior run or artifact'
    ],
    replayBoundary: 'Source workflow run ID, artifact identity and digest, downloader workflow run, exact candidate SHA, and independent verification output.',
    residue: {
      public: 'Check status, source run identifier, artifact name, and bounded verification result.',
      private: 'GitHub token and ephemeral downloaded bytes remain runner-local until bounded artifact publication.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie-productize-winner.yml:actions:read',
      'workflow-permission:.github/workflows/archie-radial-mechanism-probe.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:actions:read',
      'workflow-permission:.github/workflows/archie-terminal-efficiency-v3.yml:actions:read',
      'workflow-permission:.github/workflows/archie-typed-program-student.yml:actions:read'
    ],
    implementation: references([
      ['.github/workflows/archie-productize-winner.yml', 'actions: read', 'gh run download'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'actions: read', 'gh run download', 'Independently verify source evidence'],
      ['.github/workflows/archie-register-v4-admission.yml', 'actions: read'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'actions: read', 'SOURCE_RUN_ID', 'gh run download'],
      ['.github/workflows/archie-typed-program-student.yml', 'actions: read']
    ]),
    allowWitness: references([
      ['.github/workflows/archie-productize-winner.yml', 'Independently verify source campaign'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'Independently verify source evidence']
    ]),
    denyWitness: references([
      ['.github/workflows/archie-productize-winner.yml', 'test -n "$evidence"'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'test -n "$evidence"']
    ])
  }
];

export default {
  ...baseManifest,
  rows: [...baseManifest.rows, ...researchWorkflowRows]
};
