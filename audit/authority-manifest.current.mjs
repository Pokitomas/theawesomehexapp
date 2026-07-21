import baseManifest from './authority-manifest.mjs';

const references = values => values.map(([path, ...anchors]) => ({ path, anchors }));
const enforcedWorkflowRow = ({ id, operation, authority, surfaces, implementation, allowWitness, denyWitness }) => ({
  id,
  family: 'workflow',
  operation,
  originActor: 'GitHub push, pull-request, or explicit workflow-dispatch actor',
  principalSource: 'Read-only GitHub Actions token executing an exact candidate checkout',
  requiredAuthority: authority,
  mutableObject: 'Ephemeral runner files, immutable input copies, bounded run receipts, and uploaded research artifacts',
  authorityOwner: 'Repository CI configuration; production and admission remain separately governed',
  denialConditions: [
    'event or path filter does not match',
    'checkout, materialization, compilation, verification, evaluation, or artifact publication fails',
    'source identity or digest verification fails',
    'candidate attempts production or admission mutation'
  ],
  replayBoundary: 'Exact workflow run, candidate SHA, pinned actions, source run and artifact identities, immutable configuration, evaluation output, and promotion state.',
  residue: {
    public: 'Public check status, bounded summaries, artifact names, run identities, and cryptographic digests.',
    private: 'GitHub token and ephemeral downloaded bytes remain runner-local; no production credential or model-promotion authority is consumed.'
  },
  status: 'enforced',
  surfaces,
  implementation: references(implementation),
  allowWitness: references(allowWitness),
  denyWitness: references(denyWitness)
});

const researchWorkflowRows = [
  enforcedWorkflowRow({
    id: 'workflow.archie-research-read-only',
    operation: 'Export, normalize, train, verify, package, observe, and diagnose Archie research candidates without repository mutation authority',
    authority: 'contents:read only; no repository write authority',
    surfaces: [
      'workflow-permission:.github/workflows/archie-campaign-source-export-v2.yml:contents:read',
      'workflow-permission:.github/workflows/archie-causal-mechanism-full-budget.yml:contents:read',
      'workflow-permission:.github/workflows/archie-continuum-capsule.yml:contents:read',
      'workflow-permission:.github/workflows/archie-generalized-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-latent-world-source-export.yml:contents:read',
      'workflow-permission:.github/workflows/archie-operation-probe-v1.yml:contents:read',
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
    implementation: [
      ['.github/workflows/archie-operation-probe-v1.yml', 'permissions:', 'contents: read', 'Run frozen operation-information probe', 'research-only-not-admitted'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'contents: read', 'promotion'],
      ['.github/workflows/normalize-live-research.yml', 'contents: read', 'persist-credentials: false']
    ],
    allowWitness: [
      ['foundry/archie-protocol/latent_world_benchmark/research/test_operation_information_probe.py', 'test_linear_probe_learns_separable_latent', 'test_inventory_accepts_artifact_root_prefixed_paths']
    ],
    denyWitness: [
      ['.github/workflows/archie-operation-probe-v1.yml', 'production_changed', 'admission_changed', 'persist-credentials: false']
    ]
  }),
  enforcedWorkflowRow({
    id: 'workflow.archie-research-artifact-read',
    operation: 'Read immutable GitHub Actions artifacts and run metadata for independent research verification and bounded diagnostics',
    authority: 'contents:read and actions:read only for downloading named prior-run artifacts and independently verifying them',
    surfaces: [
      'workflow-permission:.github/workflows/archie-operation-probe-v1.yml:actions:read',
      'workflow-permission:.github/workflows/archie-productize-winner.yml:actions:read',
      'workflow-permission:.github/workflows/archie-radial-mechanism-probe.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:actions:read',
      'workflow-permission:.github/workflows/archie-terminal-efficiency-v3.yml:actions:read',
      'workflow-permission:.github/workflows/archie-terminal-run-observer.yml:actions:read',
      'workflow-permission:.github/workflows/archie-typed-program-student.yml:actions:read'
    ],
    implementation: [
      ['.github/workflows/archie-operation-probe-v1.yml', 'actions: read', 'CAMPAIGN_RUN_ID', 'TERMINAL_RUN_ID', 'gh run download'],
      ['.github/workflows/archie-terminal-efficiency-v3.yml', 'actions: read', 'SOURCE_RUN_ID', 'gh run download']
    ],
    allowWitness: [
      ['.github/workflows/archie-operation-probe-v1.yml', 'Independently verify immutable inputs', 'sha256sum -c']
    ],
    denyWitness: [
      ['.github/workflows/archie-operation-probe-v1.yml', 'test -n "$campaign_evidence"', 'test -n "$terminal_report"']
    ]
  }),
  {
    id: 'workflow.archie-continuum-capsule-signing',
    family: 'workflow-secret',
    operation: 'Sign an exact-head bounded local-compute capsule without repository mutation authority',
    originActor: 'Repository owner through explicit workflow dispatch',
    principalSource: 'ARCHIE_CONTINUUM_HMAC_KEY GitHub Actions secret used only by the capsule-signing job',
    requiredAuthority: 'Read the capsule-signing HMAC secret only after exact actor, checkout, task, and promotion checks pass',
    mutableObject: 'HMAC signature over canonical capsule JSON; the secret is never emitted',
    authorityOwner: 'Repository owner controls the Actions secret; local nodes independently control matching configuration',
    denialConditions: ['dispatch actor is not owner', 'secret is absent or weak', 'checked-out SHA differs', 'capsule contract is invalid', 'signature verification fails'],
    replayBoundary: 'Workflow run and attempt, actor, exact SHA, capsule bytes, key identifier, signature digest, and expiry.',
    residue: {
      public: 'Capsule artifact, exact source SHA, bounded task identity, creation receipt, and SHA256SUMS.',
      private: 'ARCHIE_CONTINUUM_HMAC_KEY, local matching secret, and provider credentials remain private.'
    },
    status: 'enforced',
    surfaces: ['workflow-secret:.github/workflows/archie-continuum-capsule.yml:ARCHIE_CONTINUUM_HMAC_KEY'],
    implementation: references([
      ['.github/workflows/archie-continuum-capsule.yml', 'ARCHIE_CONTINUUM_HMAC_KEY', 'Require repository owner dispatch', 'capsule-create'],
      ['compute/continuum/capsule.py', 'hmac-sha256', 'promotion must be']
    ]),
    allowWitness: references([
      ['compute/continuum/test_continuum.py', 'test_sign_and_verify_capsule']
    ]),
    denyWitness: references([
      ['compute/continuum/test_continuum.py', 'test_tampering_is_rejected', 'test_promotion_is_fail_closed']
    ])
  }
];

export default {
  ...baseManifest,
  rows: [...baseManifest.rows, ...researchWorkflowRows]
};
