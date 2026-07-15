# Full-stack takeover receipt

Base: `main` at `5bc28784e1634334dacba624d19fcb87ee8c2cd7`

Branch: `agent/fullstack-takeover`

## Assessment

Sideways currently contains three product realities sharing one ranking kernel:

1. root million-candidate reader/ranking laboratory;
2. `/manual/` user-owned private archive;
3. function-backed canonical public social authority.

The private archive is materially productized: local profile, private records, imports, media, places, persistence, Ark backup/restore, and phone gates are documented and represented in repository verification.

The public social authority is deeper than the visible product. The consumer currently reaches session, registration, login/logout, discover/following feeds, publish/reply, like, follow, and profile read/update. PostgreSQL authority additionally exposes communities, membership, roles, forks, author post edit/state, moderation, reports, appeals, viewer-local controls, community feeds, and threads without equivalent visible journeys.

The native Maker runtime is repository-shaped but externally inactive unless model variables, endpoint access, runner registration, labels, secrets, branch permissions, and hosting/database grants are supplied. A successful lasso is not proof that an engineering model ran.

## Four non-overlapping read-only lanes

### 1. Root-to-private-archive journey and frontend UX

Own only navigation, mode transitions, first-run comprehension, local/public identity separation, archive creation/import/recovery, phone overflow, and visible failure states. Do not alter social authority or Maker runtime.

### 2. Social API-to-visible-product reachability

Own only exact mapping from `/api/social` operations to reachable UI journeys and explicit unavailable-mode behavior. Do not alter private archive semantics, ranking, or operator workflows.

### 3. Native Maker/Codex activation and runtime ergonomics

Own only installation, runtime probes, self-hosted runner activation, model endpoint configuration, issue-trigger receipts, bounded tool-loop ergonomics, and operator documentation. Do not change product UX or social authority.

### 4. Hostile full-stack test, security, and operations

Own only adversarial tests, auth/cookie/origin/idempotency boundaries, migration failure behavior, deployment accounting, environment/permission blockers, secret handling, recovery, observability, and rollback. Do not add product features.

## Consolidated priority

1. Make author-owned post lifecycle visible: edit and deactivate/remove controls with confirmation, explicit PostgreSQL-only behavior, projection refresh, and contract tests.
2. Add community creation/join/view/feed journey.
3. Add dedicated thread route and reply context.
4. Add report, moderation, appeal, and appeal-decision journeys.
5. Add viewer-local mute/block controls.
6. Activate native Maker through a real model endpoint plus self-hosted runner and verify an issue-to-draft-PR episode.
7. Add hostile browser tests spanning local archive/public projection separation and unavailable backend modes.

## Selected implementation lane

Highest-leverage code-local lane: visible author post removal using existing `POST op=post-state` with `{ postId, active: false }`.

Expected implementation surface:

- `studio/manual/product/social-client.js`
  - decorate owned social cards with a destructive `REMOVE` action;
  - require explicit confirmation;
  - call `post-state` with `active: false`;
  - refresh the active feed and expose server errors without deleting private archive records.
- `studio/manual/tests/social-spine-contract.mjs`
  - require the exact operation, method, owner-only guard, confirmation, and refresh behavior.
- `audit/social-product-reachability.json`
  - move author removal from highest-priority gaps into visible operations while leaving author edit as a gap unless implemented in the same patch.

## Execution blocker

The current execution environment could not resolve `github.com`, so clone, `npm ci`, `npm run test:native-maker`, `npm run verify:repository`, Codex installation, and local diff inspection could not run. The connected GitHub API permitted branch creation and repository inspection but did not provide a safe partial-file patch primitive for the 449-line client. No untested product code was fabricated.

## Required verification after implementation

```bash
npm ci --ignore-scripts
npm run test:social
node studio/manual/tests/social-spine-contract.mjs
npm run verify:repository
git diff --check
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- studio/manual/product/social-client.js studio/manual/tests/social-spine-contract.mjs audit/social-product-reachability.json
```

## Co-agent parallel completion instruction

Continue from `agent/fullstack-takeover` without touching the selected author-removal files until that lane lands. Split remaining work into three branches:

- `agent/social-communities`: community create/join/view/feed and dedicated thread journey;
- `agent/social-safety-controls`: report, moderation, appeal, appeal decision, mute, and block journeys;
- `agent/maker-runtime-activation`: Codex/open-model probe, self-hosted runner ergonomics, blocked-receipt diagnostics, and one real issue-to-draft-PR proof.

Each branch must add focused contracts, run its local suite plus `npm run verify:repository`, document external blockers separately from repository failures, and return a cherry-pickable commit with no overlap in `studio/manual/product/social-client.js` unless coordinated through a shared integration branch.