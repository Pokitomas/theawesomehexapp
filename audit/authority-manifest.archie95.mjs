const reference = (path, ...anchors) => ({ path, anchors });

export default [
  {
    id: 'workflow.archie-register-artifact-verification',
    family: 'workflow',
    operation: 'Verify exact register admission artifacts and the Archie 95 browser package through read-only GitHub Actions',
    originActor: 'GitHub push, pull-request, or manual actor',
    principalSource: 'Read-only GitHub Actions token executing the exact candidate head and reading immutable repository artifacts',
    requiredAuthority: 'contents:read and actions:read only',
    mutableObject: 'Immutable admission artifacts, hidden sealed packs, browser-package bytes, check results, and bounded evidence artifacts',
    authorityOwner: 'Repository CI configuration and GitHub Actions artifact retention',
    denialConditions: ['event or branch filter does not match', 'artifact is missing or expired', 'artifact or package digest differs', 'controller, parity, sealed replay, protected suite, or static serving check fails'],
    replayBoundary: 'Exact workflow run, candidate SHA, artifact IDs and digests, model and controller digests, sealed row outcomes, and invoked protected commands.',
    residue: {
      public: 'Public check status, bounded metrics, and artifact identifiers.',
      private: 'GitHub token, artifact transport authorization, hidden seed material, and ephemeral runner files are discarded.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v3-formal-negative.yml:actions:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:contents:read',
      'workflow-permission:.github/workflows/archie-register-v4-admission.yml:actions:read',
      'workflow-permission:.github/workflows/archie95-admitted-app.yml:contents:read',
      'workflow-permission:.github/workflows/archie95-admitted-app.yml:actions:read'
    ],
    implementation: [
      reference('.github/workflows/archie-register-v3-formal-negative.yml', 'contents: read', 'actions: read', 'persist-credentials: false'),
      reference('.github/workflows/archie-register-v4-admission.yml', 'contents: read', 'actions: read', 'persist-credentials: false'),
      reference('.github/workflows/archie95-admitted-app.yml', 'contents: read', 'actions: read', 'persist-credentials: false', 'Replay 1,800 sealed cases through browser package')
    ],
    allowWitness: [reference('.github/workflows/archie95-admitted-app.yml', 'Verify package identity and app shell')],
    denyWitness: [reference('.github/workflows/archie95-admitted-app.yml', 'sealed replay failed')]
  },
  {
    id: 'workflow.archie95-package-admitted-model',
    family: 'workflow',
    operation: 'Materialize the exact admitted V4 artifact into the bounded Archie 95 product branch',
    originActor: 'Repository-authorized push actor or explicit manual-dispatch actor; GitHub Actions bot pushes are excluded',
    principalSource: 'GitHub Actions token with actions:read and branch-scoped contents:write during one packaging job',
    requiredAuthority: 'actions:read to fetch one immutable admitted artifact and contents:write only to commit digest-bound generated model assets and governance repairs to agent/archie95-admitted-model-20260721',
    mutableObject: 'Archie 95 controller, compressed model parts, package manifest and receipt, pinned workflow sources, authority-manifest rows, and one branch commit',
    authorityOwner: 'Repository owner retains review and merge authority; the workflow is bounded to the named product branch',
    denialConditions: ['actor is github-actions bot', 'source artifact or inner digest differs', 'browser reconstruction or route probes fail', 'governance patch anchor is absent', 'no staged change exists', 'branch push is rejected'],
    replayBoundary: 'Source artifact ID and digest, source report digest, candidate SHA, generated package digests, route probes, staged paths, commit SHA, and exact target branch.',
    residue: {
      public: 'Workflow status, generated assets, receipt, commit, and pull-request diff are public.',
      private: 'GitHub token and artifact transport authorization remain private; no model source beyond the admitted public package is exposed.'
    },
    status: 'enforced',
    surfaces: [
      'workflow-permission:.github/workflows/archie95-package-admitted-model.yml:contents:write',
      'workflow-permission:.github/workflows/archie95-package-admitted-model.yml:actions:read'
    ],
    implementation: [reference('.github/workflows/archie95-package-admitted-model.yml', 'contents: write', 'actions: read', "github.actor != 'github-actions[bot]'", 'persist-credentials: false', '8487452814', 'Verify packaged browser runtime', 'agent/archie95-admitted-model-20260721')],
    allowWitness: [reference('.github/workflows/archie95-package-admitted-model.yml', 'Commit generated package')],
    denyWitness: [reference('.github/workflows/archie95-package-admitted-model.yml', "github.actor != 'github-actions[bot]'")]
  }
];
