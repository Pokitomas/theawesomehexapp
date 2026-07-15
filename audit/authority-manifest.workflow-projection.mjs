export default [
  {
    id: 'workflow.pages-authority', f: 'workflow', op: 'Build and deploy Pages, mint OIDC, and mutate deployment receipts',
    actor: 'GitHub push actor; pull requests may build but cannot reach deploy authority',
    principal: 'GitHub Actions token and OIDC context in the push-only deploy job',
    auth: 'contents:read globally; pages:write, id-token:write, and issues:write only in push deploy',
    object: 'Pages artifact, deployment, OIDC token, and deployment receipt issue', owner: 'GitHub repository and protected Pages environment',
    deny: 'event is not push|remote gate denies proceed|token permission absent|environment protection denies deploy',
    replay: 'Exact workflow run and commit; deployment receipt binds the live sentinel to the merged SHA.',
    pub: 'Pages deployment and deployment receipt are public.', priv: 'OIDC token and workflow execution context remain private.', st: 'e',
    s: [
      'workflow-permission:.github/workflows/pages.yml:contents:read',
      'workflow-permission:.github/workflows/pages.yml:pages:write',
      'workflow-permission:.github/workflows/pages.yml:id-token:write',
      'workflow-permission:.github/workflows/pages.yml:issues:write'
    ],
    impl: [['.github/workflows/pages.yml', 'permissions:', "if: github.event_name == 'push'", 'pages: write', 'id-token: write', 'issues: write']],
    allow: [['scripts/tests/deployment-receipt.test.mjs', 'deployment']],
    denyW: [['scripts/tests/workflow-permissions.test.mjs', 'Pages, OIDC, and issue mutation authority exist only in the push-only deploy job']]
  },
  {
    id: 'workflow.lasso-authority', f: 'workflow', op: 'Sign and append lasso arrivals from repository events',
    actor: 'GitHub issue, comment, pull-request, or review event actor', principal: 'Trusted default-branch lasso code plus injected Remote signing secrets',
    auth: 'contents:read and configured Remote principal credentials', object: 'Remote weave arrival and grouped message', owner: 'Universal Remote authority delegated to the lasso principal',
    deny: 'credentials absent produces verified no-op|trusted checkout verification fails|Remote authentication or capability denial',
    replay: 'Deterministic lasso identifiers plus Remote nonce and message-id boundaries.',
    pub: 'Sanitized lasso summaries may enter public Remote projection.', priv: 'REMOTE_KEY and raw event payload remain private.', st: 'e',
    s: [
      'workflow-permission:.github/workflows/weave-lasso.yml:contents:read',
      'workflow-secret:.github/workflows/weave-lasso.yml:REMOTE_URL',
      'workflow-secret:.github/workflows/weave-lasso.yml:REMOTE_KEY',
      'workflow-secret:.github/workflows/weave-lasso.yml:REMOTE_LASSO_PRINCIPAL',
      'workflow-secret:.github/workflows/weave-lasso.yml:REMOTE_SESSION',
      'workflow-secret:.github/workflows/weave-lasso.yml:REMOTE_GENERATION'
    ],
    impl: [['.github/workflows/weave-lasso.yml', 'Verify trusted lasso before execution', 'REMOTE_KEY: ${{ secrets.REMOTE_KEY }}', 'node scripts/weave-lasso.mjs github-event']],
    allow: [['scripts/tests/weave-lasso-adversarial.test.mjs', 'repeated delivery']],
    denyW: [['scripts/tests/workflow-permissions.test.mjs', 'secret-bearing lasso execution uses only trusted default-branch code']]
  },
  {
    id: 'workflow.native-maker-authority', f: 'workflow', op: 'Turn an owner-authored Maker issue into a bounded model patch and draft pull request',
    actor: 'Repository owner opening/reopening a [maker:*] issue or manually dispatching an existing Maker issue',
    principal: 'Trusted default-branch native worker with a scoped GitHub Actions token and optional model endpoint credential',
    auth: 'read-only preflight proves owner actor, owner issue author, and Maker title; blocked receipts use issues:write; admitted worker jobs use contents:write, pull-requests:write, and issues:write',
    object: 'Worker branch, commit, draft pull request, source-issue receipts, and non-secret Actions episode artifact', owner: 'GitHub repository; merge and deployment remain human authority',
    deny: 'actor is not repository owner|issue author is not repository owner|issue is not [maker:*]|mode is unconfigured|model endpoint/model missing|trusted worker tests fail|model tool request violates path, authority, write, or witness boundary|repository verification fails',
    replay: 'Issue number, preflight output, Actions run and attempt, generated branch, commit, draft PR, model endpoint host/model receipt, planning and implementation episode, and repository verification witnesses.',
    pub: 'Issue receipts, branch, draft PR, code diff, tests, non-secret provider identity, and structured episode artifact are public.',
    priv: 'Model API key, runner registration token, local model process, bearer credentials, and endpoint authorization remain private.', st: 'e',
    s: [
      'workflow-permission:.github/workflows/maker-native-worker.yml:contents:read',
      'workflow-permission:.github/workflows/maker-native-worker.yml:issues:read',
      'workflow-permission:.github/workflows/maker-native-worker.yml:contents:write',
      'workflow-permission:.github/workflows/maker-native-worker.yml:issues:write',
      'workflow-permission:.github/workflows/maker-native-worker.yml:pull-requests:write',
      'workflow-secret:.github/workflows/maker-native-worker.yml:SIDEWAYS_MODEL_API_KEY'
    ],
    impl: [['.github/workflows/maker-native-worker.yml', 'Prove owner-authored Maker command', 'ownerAuthored', 'makerTitle', 'ownerActor', "needs.preflight.outputs.allowed == 'true'", 'Check out trusted default-branch worker', 'Verify native worker before write authority', 'node scripts/maker-native-worker.mjs']],
    allow: [['scripts/tests/native-maker-worker.test.mjs', 'native dev agent reads, writes, witnesses, inspects, and finishes'], ['scripts/tests/workflow-permissions.test.mjs', 'native Maker write authority is preflight-gated']],
    denyW: [['scripts/tests/native-maker-worker.test.mjs', 'rejects path escape, secrets, authority writes, and arbitrary witnesses'], ['scripts/tests/workflow-permissions.test.mjs', 'preflight-gated, trusted-main, and draft-PR bounded']]
  },
  {
    id: 'workflow.coordination-ticks', f: 'workflow', op: 'Reduce repository events into one bounded coordination-state comment',
    actor: 'GitHub repository event actor', principal: 'Trusted default-branch reducer with the workflow GITHUB_TOKEN',
    auth: 'contents:read, pull-requests:read, actions:read, and issues:write', object: 'One machine-readable state comment on issue #131', owner: 'Repository coordination workflow',
    deny: 'untrusted reducer code is never checked out|duplicate event fingerprint|reducer or hostile witnesses fail|GitHub token lacks issue write',
    replay: 'SHA-256 event fingerprints, one repository-wide concurrency group, and one state-comment update.',
    pub: 'Open-lane phase, collisions, and bounded transitions are public.', priv: 'No secrets are consumed; verbose historical provenance is compacted before persistence.', st: 'e',
    s: [
      'workflow-permission:.github/workflows/coordination-ticks.yml:contents:read',
      'workflow-permission:.github/workflows/coordination-ticks.yml:issues:write',
      'workflow-permission:.github/workflows/coordination-ticks.yml:pull-requests:read',
      'workflow-permission:.github/workflows/coordination-ticks.yml:actions:read'
    ],
    impl: [['.github/workflows/coordination-ticks.yml', 'Check out trusted default-branch reducer', 'issues: write', 'cancel-in-progress: false']],
    allow: [['scripts/tests/coordination-tick.test.mjs', 'activity and non-activity are complementary legs'], ['scripts/tests/coordination-tick-hardening.test.mjs', 'one actor claiming two branches']],
    denyW: [['scripts/tests/coordination-tick-hardening.test.mjs', 'remains inside GitHub comment limits']]
  },
  {
    id: 'workflow.authority-audit', f: 'workflow', op: 'Run authority-manifest drift checks',
    actor: 'GitHub push, pull request, or manual actor', principal: 'Read-only GitHub Actions token', auth: 'contents:read',
    object: 'Check result only', owner: 'Repository CI configuration', deny: 'checkout or Node setup fails|manifest checker reports drift',
    replay: 'Exact workflow run and commit SHA.', pub: 'Public check status.', priv: 'No secrets are consumed.', st: 'e',
    s: ['workflow-permission:.github/workflows/authority-audit.yml:contents:read'],
    impl: [['.github/workflows/authority-audit.yml', 'contents: read', 'npm run test:authority']],
    allow: [['scripts/tests/authority-manifest.test.mjs', 'manifest covers every discovered in-repository authority surface']],
    denyW: [['scripts/tests/authority-manifest.test.mjs', 'removing one mapped surface is detected as drift']]
  },
  {
    id: 'workflow.read-only-ci', f: 'workflow', op: 'Run repository verification workflows with read-only contents access',
    actor: 'GitHub push or pull-request actor', principal: 'Read-only GitHub Actions token', auth: 'contents:read only',
    object: 'Check results and proof artifacts', owner: 'Repository CI configuration', deny: 'event or path filter does not match|checkout or test fails',
    replay: 'GitHub run and exact commit SHA.', pub: 'Public check status and intentional proof artifacts.', priv: 'No repository mutation or secret authority is declared.', st: 'e',
    s: [
      'workflow-permission:.github/workflows/repository-gate.yml:contents:read',
      'workflow-permission:.github/workflows/weave.yml:contents:read',
      'workflow-permission:.github/workflows/weave-recursive.yml:contents:read',
      'workflow-permission:.github/workflows/founder-room.yml:contents:read',
      'workflow-permission:.github/workflows/maker-console.yml:contents:read',
      'workflow-permission:.github/workflows/maker-native-worker-ci.yml:contents:read',
      'workflow-permission:.github/workflows/maker-pr-collision-gate.yml:contents:read',
      'workflow-permission:.github/workflows/maker-pr-collision-gate.yml:pull-requests:read',
      'workflow-permission:.github/workflows/social-spine-phone.yml:contents:read',
      'workflow-permission:.github/workflows/validate-manual-overlay.yml:contents:read',
      'workflow-permission:.github/workflows/survival-ledger-phone.yml:contents:read',
      'workflow-permission:.github/workflows/universal-media-phone.yml:contents:read',
      'workflow-permission:.github/workflows/social-postgres-contract.yml:contents:read',
      'workflow-permission:.github/workflows/frontier-phone-proof.yml:contents:read',
      'workflow-permission:.github/workflows/kernel-parity-check.yml:contents:read',
      'workflow-permission:.github/workflows/manual-kernel-phone.yml:contents:read',
      'workflow-permission:.github/workflows/remote-authority-assembly.yml:contents:read',
      'workflow-permission:.github/workflows/social-authority-assembly.yml:contents:read',
      'workflow-permission:.github/workflows/social-authority-schema.yml:contents:read',
      'workflow-permission:.github/workflows/workflow-permissions.yml:contents:read',
      'workflow-permission:.github/workflows/coordination-tick-ci.yml:contents:read'
    ],
    impl: [['.github/workflows/repository-gate.yml', 'contents: read', 'persist-credentials: false'], ['.github/workflows/weave-recursive.yml', 'contents: read', 'persist-credentials: false'], ['.github/workflows/maker-console.yml', 'contents: read', 'persist-credentials: false'], ['.github/workflows/maker-native-worker-ci.yml', 'contents: read', 'persist-credentials: false'], ['.github/workflows/maker-pr-collision-gate.yml', 'contents: read', 'pull-requests: read', 'Check out trusted default-branch gate', 'persist-credentials: false'], ['.github/workflows/coordination-tick-ci.yml', 'contents: read'], ['.github/workflows/remote-authority-assembly.yml', 'contents: read'], ['.github/workflows/social-authority-assembly.yml', 'contents: read'], ['.github/workflows/social-authority-schema.yml', 'contents: read'], ['.github/workflows/workflow-permissions.yml', 'contents: read'], ['.github/workflows/weave.yml', 'contents: read']],
    allow: [['scripts/tests/authority-manifest.test.mjs', 'read-only and coordination workflows remain explicitly mapped']],
    denyW: [['scripts/tests/authority-manifest.test.mjs', 'read-only and coordination workflows remain explicitly mapped']]
  },
  {
    id: 'projection.remote-public', f: 'projection', op: 'Project private Remote operational state into public LIVE and state payloads',
    actor: 'Public HTTP reader', principal: 'No credential when public=1', auth: 'fixed sanitizer and projection schema only',
    object: 'Public Remote state, terminal receipt, and message representation', owner: 'Universal Remote projection code',
    deny: 'private visibility excluded|signature, nonce, grant, receipt payload, and terminating principal omitted|unknown nested fields do not flow through',
    replay: 'Read-only deterministic projection of current stored state and messages.',
    pub: 'Allowlisted state, summary, counts, claims, terminal identity/state, and public messages.',
    priv: 'Credentials, nonces, signatures, private payloads, production receipt bodies, grants, and hidden evidence remain private.', st: 'e',
    s: ['public-projection:publicMessageProjection', 'public-projection:publicStateProjection', 'public-projection:publicTerminalReceiptProjection'],
    impl: [['netlify/functions/remote-core.mjs', 'export function publicMessageProjection', 'export function publicStateProjection', 'export function publicTerminalReceiptProjection']],
    allow: [['scripts/tests/remote-public-privacy.test.mjs', 'public projections preserve explicit summaries']],
    denyW: [['scripts/tests/remote-public-privacy.test.mjs', 'the production-edge public response allowlists state and terminal receipt fields']]
  }
];
