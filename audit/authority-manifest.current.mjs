import baseManifest from './authority-manifest.mjs';

const references = values => values.map(([path, ...anchors]) => ({ path, anchors }));

const researchWorkflowRows = [
  {
    id: 'workflow.archie-research-read-only',
    family: 'workflow',
    operation: 'Export, normalize, train, verify, package, observe, and issue signed local-compute capsules for Archie research candidates without repository mutation authority',
    originActor: 'GitHub push, pull-request, or explicit workflow-dispatch actor',
    principalSource: 'Read-only GitHub Actions token executing an exact candidate checkout',
    requiredAuthority: 'contents:read only for source, normalization, verification, observation, and signed-capsule workflows; no repository write authority',
    mutableObject: 'Ephemeral runner files, normalized research patches, digest-bound evidence bundles, signed research capsules, bounded run receipts, and uploaded research artifacts',
    authorityOwner: 'Repository CI configuration; admission remains governed separately',
    denialConditions: [
      'event or path filter does not match',
      'checkout, normalization, materialization, compilation, training, evaluation, observation, capsule signing, or artifact publication fails',
      'evidence, run receipt, or capsule verification fails',
      'candidate attempts admission or production mutation'
    ],
    replayBoundary: 'Exact workflow run, candidate and merge SHA, pinned actions, normalized patch identity, source and artifact digests, signed capsule digest, observed run identity, optimizer budget, frozen evaluation suites, and terminal promotion state.',
    residue: {
      public: 'Public check status, bounded summaries, artifact names, normalized patch receipts, observed run identities, signed capsule identities, and cryptographic digests.',
      private: 'Ephemeral runner state and GitHub token are discarded; signing authority is represented separately and no production credential or model-promotion authority is consumed.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie-campaign-source-export-v2.yml:contents:read',
      'workflow-permission:.github/workflows/archie-causal-mechanism-full-budget.yml:contents:read',
      'workflow-permission:.github/workflows/archie-continuum-capsule.yml:contents:read',
      'workflow-permission:.github/workflows/archie-generalized-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-latent-world-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-operation-identity-frozen-probe-v1.yml:contents:read',
      'workflow-permission:.github/workflows/archie-productize-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-productize-winner.yml:contents:read',
      'workflow-permission:.github/workflows/archie-radial-mechanism-probe.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:contents:read',
      'workflow-permission:.github/workflows/archie-terminal-efficiency-v3.yml:contents:read',
      'workflow-permission:.github/workflows/archie-terminal-run-observer.yml:contents:read',
      'workflow-permission:.github/workflows/archie-typed-program-freeze-v3.yml:contents:read',
      'workflow-permission:.github/workflows/archie-typed-program-student.yml:contents:read',
      'workflow-permission:.github/workflows/normalize-live-research.yml:contents:read'
    ],
    implementation: references([
      ['.github/workflows/archie-causal-mechanism-full-budget.yml', 'permissions:', 'contents: read', 'Independently verify evidence bundle'],
      ['.github/workflows/archie-continuum-capsule.yml', 'contents: read', 'Require repository owner dispatch', 'Sign exact checked-out source capsule'],
      ['.github/workflows/archie-operation-identity-frozen-probe-v1.yml', 'contents: read', 'Run frozen probes without executor training', 'research-only-not-admitted'],
      ['.github/workflows/archie-productize-winner.yml', 'contents: read', 'shadow-product-not-admitted'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'contents: read', 'promotion'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'contents: read', 'promotion'],
      ['.github/workflows/archie-terminal-run-observer.yml', 'contents: read', 'Observe terminal tournament to completion'],
      ['.github/workflows/archie-typed-program-student.yml', 'contents: read', 'promotion'],
      ['.github/workflows/normalize-live-research.yml', 'contents: read', 'Rewrite research surfaces around live sources', 'persist-credentials: false']
    ]),
    allowWitness: references([
      ['compute/continuum/test_continuum.py', 'test_sign_and_verify_capsule'],
      ['foundry/archie-protocol/latent_world_benchmark/research/test_frozen_operation_probe.py', 'test_artifact_receipt_is_fail_closed', 'test_state_dict_digest_changes_with_parameter'],
      ['scripts/tests/supply-chain-contract.test.mjs', 'read-only proof workflows disable persisted checkout credentials']
    ]),
    denyWitness: references([
      ['compute/continuum/test_continuum.py', 'test_tampering_is_rejected', 'test_promotion_is_fail_closed'],
      ['.github/workflows/archie-operation-identity-frozen-probe-v1.yml', 'Enforce distinct POK-185 execution boundary', 'executor_training_performed'],
      ['.github/workflows/archie-productize-winner.yml', 'promotion'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'promotion']
    ])
  },
  {
    id: 'workflow.archie-research-artifact-read',
    family: 'workflow',
    operation: 'Read immutable GitHub Actions artifacts and run metadata for independent admission, continuation evaluation, and bounded completion observation',
    originActor: 'GitHub pull-request or explicit workflow-dispatch actor',
    principalSource: 'GitHub Actions token scoped to actions:read and contents:read',
    requiredAuthority: 'actions:read only for downloading named prior-run artifacts and reading bounded workflow-run metadata',
    mutableObject: 'Ephemeral copies of immutable workflow artifacts and bounded run receipts',
    authorityOwner: 'GitHub Actions artifact service and repository CI configuration',
    denialConditions: [
      'source run is absent or incomplete',
      'artifact or run metadata cannot be read',
      'artifact digest or independent verification fails',
      'workflow attempts to mutate a prior run or artifact'
    ],
    replayBoundary: 'Source workflow run ID, observed workflow run ID, artifact identity and digest, downloader or observer workflow run, exact candidate SHA, and independent verification output.',
    residue: {
      public: 'Check status, source and observed run identifiers, artifact name, and bounded verification result.',
      private: 'GitHub token and ephemeral downloaded bytes remain runner-local until bounded artifact publication.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie-operation-identity-frozen-probe-v1.yml:actions:read',
      'workflow-permission:.github/workflows/archie-productize-winner.yml:actions:read',
      'workflow-permission:.github/workflows/archie-radial-mechanism-probe.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:actions:read',
      'workflow-permission:.github/workflows/archie-terminal-efficiency-v3.yml:actions:read',
      'workflow-permission:.github/workflows/archie-terminal-run-observer.yml:actions:read',
      'workflow-permission:.github/workflows/archie-typed-program-student.yml:actions:read'
    ],
    implementation: references([
      ['.github/workflows/archie-operation-identity-frozen-probe-v1.yml', 'actions: read', 'TERMINAL_ARTIFACT_ID', 'CAMPAIGN_ARTIFACT_ID', 'Download exact immutable artifacts by ID'],
      ['.github/workflows/archie-productize-winner.yml', 'actions: read', 'gh run download'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'actions: read', 'gh run download', 'Independently verify source evidence'],
      ['.github/workflows/archie-register-v4-admission.yml', 'actions: read'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'actions: read', 'SOURCE_RUN_ID', 'gh run download'],
      ['.github/workflows/archie-terminal-run-observer.yml', 'actions: read', 'Poll push-triggered tournament'],
      ['.github/workflows/archie-typed-program-student.yml', 'actions: read']
    ]),
    allowWitness: references([
      ['.github/workflows/archie-operation-identity-frozen-probe-v1.yml', 'Verify terminal checkpoint inventory', 'Independently verify canonical campaign artifact'],
      ['.github/workflows/archie-productize-winner.yml', 'Independently verify source campaign'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'Independently verify source evidence'],
      ['.github/workflows/archie-terminal-run-observer.yml', 'receipt.json', 'SHA256SUMS']
    ]),
    denyWitness: references([
      ['.github/workflows/archie-operation-identity-frozen-probe-v1.yml', 'test "$TERMINAL_ARTIFACT_ID" = "8510576517"', 'test "$CAMPAIGN_ARTIFACT_ID" = "8504094525"'],
      ['.github/workflows/archie-productize-winner.yml', 'test -n "$evidence"'],
      ['.github/workflows/archie-radial-mechanism-probe.yml', 'test -n "$evidence"'],
      ['.github/workflows/archie-terminal-run-observer.yml', 'Enforce observed completion']
    ])
  },
  {
    id: 'workflow.archie-continuum-capsule-signing',
    family: 'workflow-secret',
    operation: 'Sign an exact-head, bounded local-compute capsule without granting the workflow or local machine repository mutation authority',
    originActor: 'Repository owner through explicit workflow dispatch',
    principalSource: 'ARCHIE_CONTINUUM_HMAC_KEY GitHub Actions secret used only by the capsule-signing job',
    requiredAuthority: 'Read the capsule-signing HMAC secret after repository-owner identity, exact checkout SHA, task-contract, and promotion-boundary checks pass',
    mutableObject: 'HMAC signature over the canonical capsule JSON; the secret itself is never emitted',
    authorityOwner: 'Repository owner controls the GitHub Actions secret; each local node independently controls the matching local environment variable and task allowlist',
    denialConditions: [
      'dispatch actor is not the repository owner',
      'HMAC secret is absent or shorter than the local minimum',
      'checked-out SHA differs from GITHUB_SHA',
      'task, arguments, node list, shard count, expiry, or promotion boundary is invalid',
      'capsule signature or local verification fails'
    ],
    replayBoundary: 'Workflow run and attempt, dispatch actor, exact GITHUB_SHA, capsule canonical bytes, key identifier, signature digest, expiry, local node identity, and local allowlist version.',
    residue: {
      public: 'Capsule artifact, exact source SHA, bounded task identity, node/shard declaration, creation receipt, and SHA256SUMS.',
      private: 'ARCHIE_CONTINUUM_HMAC_KEY, local matching secret, and provider credentials remain private and are never written to artifacts or logs.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-secret:.github/workflows/archie-continuum-capsule.yml:ARCHIE_CONTINUUM_HMAC_KEY'
    ],
    implementation: references([
      ['.github/workflows/archie-continuum-capsule.yml', 'ARCHIE_CONTINUUM_HMAC_KEY', 'Require repository owner dispatch', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"', 'capsule-create'],
      ['compute/continuum/capsule.py', 'hmac-sha256', 'promotion must be'],
      ['compute/continuum/cli.py', 'must contain at least 32 characters']
    ]),
    allowWitness: references([
      ['compute/continuum/test_continuum.py', 'test_sign_and_verify_capsule', 'test_capsule_workflow_binds_source_to_github_sha']
    ]),
    denyWitness: references([
      ['compute/continuum/test_continuum.py', 'test_tampering_is_rejected', 'test_promotion_is_fail_closed', 'test_unknown_task_argument_is_rejected']
    ])
  }
];

export default {
  ...baseManifest,
  rows: [...baseManifest.rows, ...researchWorkflowRows]
};
