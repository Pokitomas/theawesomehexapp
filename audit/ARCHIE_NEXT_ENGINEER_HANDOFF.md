# Archie Democratized Runtime — Finishing Integration Handoff

**Repository:** `Pokitomas/theawesomehexapp`  
**Canonical base PR:** #330 (`agent/archie-linux-corpus`)  
**Exact base SHA:** `323e9d0b047284123ba1db1f3717d9ed22b5cb31`  
**Only coordinator branch:** `agent/archie-democratized-runtime`  
**Coordinator head observed at handoff:** `ba9a777504b96a49df29d2dac45988a3acbfb801`  
**Initial clean coordinator head:** `8ade93784e5af71fed421a92645e174d3add627d`  

## Authority granted to the next finishing engineer

The next engineer is authorized to inspect the entire repository; create, update, and delete task-related files; create and preserve branches; commit and push; run and edit CI workflows; read and comment on issues, reviews, PRs, and checks; apply exact reviewed repair bundles; source-admit exact files from component branches; repair integration seams; update `package.json`, verification manifests, workflow files, audit records, and README documentation; open and update the final draft PR; and, **after exact-head review is complete and all applicable workflows are successful**, merge the final PR.

The engineer must not deploy, mutate production data, expose or rotate secrets, grant itself additional external credentials, change billing, or claim external hardware/provider availability without evidence. Repository settings or collaborator permissions may be changed only when Kai explicitly performs or separately authorizes that platform-level action. No force-push may erase evidence. Preserve all failed/superseded states on named branches.

If the next engineer uses the same connected GitHub integration, the existing connector already has repository write/admin-capable access. If it is a different GitHub account, prose in this file does **not** grant platform access; Kai must add that GitHub username under repository **Settings → Collaborators and teams / Collaborators → Add people**. `Maintain` is sufficient for this integration task; `Admin` also grants settings, collaborator, security, and destructive repository powers and should be used only deliberately.

## Terminal objective

Leave one exact-head, green, mergeable draft PR:

- base: `agent/archie-linux-corpus`
- head: `agent/archie-democratized-runtime`

The PR must prove local recurring-task learning on ordinary CPUs, deterministic owned-memory export/restore, end-to-end encrypted personal synchronization without relay plaintext authority, truthful admitted opportunistic compute, a receipt-only phone cockpit, matched hostile evaluation, and explicit external blockers. README/product language must explain the hardware–software gap and how Archie democratizes useful local capability without pretending to be a frontier neural model.

## Canonical component stack and inherited composition problem

- PR #320 is validation-only substrate. Never merge it wholesale or retarget it to `main`.
- PR #321 selected repaired router: `21f0ff915a87801fb01a1f967bb36d3a3c3be37a`.
- PR #328 runtime composition: `e3912bd7c0494f6ecfd64f00a3ef61cc20ae3069`.
- PR #330 Archie base: `323e9d0b047284123ba1db1f3717d9ed22b5cb31`.

PR #328 remains composition-tainted. Current exact component evidence:

- PR #317 control plane: `b09ebf91385fc12dc83171d5ac1e55902719efd8`; mergeable draft, but hostile P0 authentication/authority findings remain unresolved. Do not treat 25/25 as sufficient.
- PR #321 router: `21f0ff915a87801fb01a1f967bb36d3a3c3be37a`; selected repaired implementation, 30/30 claimed and exact files already source-admitted.
- PR #324 repaired worker fleet: `82c4dc2a5096c7ed6ccf47e1331af73768bf4727`; 25/25 hostile proof claimed. Prefer this over the older fleet physically present in #330 after exact-path review.
- PR #325 plugin registry: `7e2e62afb6e82cf6ad00ecbaa84486f45697a049`; hostile review found major admission, approval-expiry, sandbox-abort, secret, dependency, and durability defects. A tested 27/27 repair bundle is posted in the PR discussion with bundle SHA-256 `68a4bb662356095d4d0e6724ef8da0d286a832a61f867b60016d6ab9fe7ac084`, but it was not applied to the PR head at this handoff. Verify bundle digest, inspect every file, apply only the three leased paths, and retest before admission.
- PR #328: `e3912bd7c0494f6ecfd64f00a3ef61cc20ae3069`; its own 96/96 result does not resolve obsolete/vulnerable physical component heads.

Required composition hostile seams: unknown provider/worker/plugin authority, approval expiry, dispatch/control ambiguity, lease-token privacy, partial-failure rollback, and interruption recovery.

## Admitted and candidate Archie lanes

### Lane 1 — corpus pack

Already present from initial clean coordinator head:

- `maker/contracts/archie-corpus-pack.schema.json`
- `scripts/maker-archie-corpus-pack.mjs`
- `scripts/tests/maker-archie-corpus-pack.test.mjs`

Original handoff recorded 5/5 for deterministic export/import, digest and size bounds, path traversal, duplicates, secrets, symlinks, replacement authority, staging, and rollback. Re-run on the exact coordinator tree before final admission.

### Lane 2 — reasoning budget and repaired router

Source branch/head: `agent/archie-reasoning-budget@483fcdf378f135d76cb327c13fe349cfec2f1785`.

Admitted paths:

- `maker/contracts/archie-budget.schema.json`
- `scripts/maker-archie-budget.mjs`
- `scripts/tests/maker-archie-budget.test.mjs`
- `maker/contracts/model-router.schema.json`
- `scripts/maker-model-router.mjs`
- `scripts/tests/maker-model-router.test.mjs`

Coordinator admission commit: `28b9db5954b27f53f56710e418cf7f2c08b8c530`.

The router blobs exactly came from PR #321. Re-run budget and router suites on the final tree; verify accounting, ceilings, reservations, usage evidence, cancellation/fallback/failure, teacher value, local-first behavior, and no hidden spend.

### Lane 3 — CPU-first planner

Source branch/head: `agent/archie-cpu-planner@ba17bf181df96d923a8378839e22040de9ad3250`.

Admitted paths:

- `maker/contracts/archie-planner.schema.json`
- `scripts/maker-archie-planner.mjs`
- `scripts/tests/maker-archie-planner.test.mjs`

Coordinator admission commit: `1d9e4d8cdaf57db316e259aedd0e52a489328ba8`.

Preserve sparse baseline, CPU planner, and teacher as independently evaluable routes. Prove typed grammar, composition, calibration, rejection, negative learning, incremental retraining, quantization, deterministic bounded inference, CPU receipts, tamper rejection, and truthful `not_a_neural_language_model` reporting.

### Lane 4 — opportunistic compute

Source branch/head: `agent/archie-opportunistic-compute@88e3f6ead5f9f2c34096d52f19df3e7f5345534d`.

Admitted paths:

- `maker/contracts/archie-compute.schema.json`
- `scripts/maker-archie-compute.mjs`
- `scripts/tests/maker-archie-compute.test.mjs`

Coordinator admission commit: `26bea86162c4ad5b204e2c9568e38c8fbfb7d23c`.

Local focused proof recorded 9/9. The module fails closed for unobserved workers; binds worker/task/fence/artifact digests; enforces requirements, cost, privacy, locality, pack compatibility, timeout, cancellation, retry, stale-worker rejection, and explicit neural-distillation blockers. Re-run on final tree.

### Lane 5 — encrypted personal synchronization

Current source branch/head: `agent/archie-encrypted-sync@6895c748d91023a22a5ab3f09caf5030632d5e3f`.

Exact source blobs:

- `maker/contracts/archie-sync.schema.json` — `1b59eff417ba863c169b8a0739c159ba043c4767`
- `scripts/maker-archie-sync.mjs` — `6ce874d2807b74f7f54effa4815ff29dce035c3d`
- `scripts/tests/maker-archie-sync.test.mjs` — `e70bc87869183ed0ca5aec2960cd7b9a041b75de`

Independent exact-blob Node execution passed 11/11. It covers AES-256-GCM, random/non-reused nonces, AAD, wrong-key/tamper rejection, replay/rollback generations, namespace/key isolation, resumable bounded chunks, concurrent conflict preservation, deterministic safe merges, tombstones, metadata minimization, offline state, and no relay plaintext or key authority.

### Lane 6 — phone/operator seam

Source branch/head: `agent/archie-phone-operator@5d254fcd20e34480262e1c8e2379b62dbfee2ee5`.

Admitted leased paths currently include:

- `maker/contracts/archie-operator.schema.json`
- `scripts/maker-archie-operator.mjs`
- `scripts/tests/maker-archie-operator.test.mjs`
- `maker/index.html`

Exact module-only proof passed 6/6. Earlier lane run reported 7/7 with the Chromium test skipped because the isolated fixture lacked `playwright-core`. The final repository workflow must run real Chromium at 390×844 and desktop, verify reflow/overflow, keyboard/focus/reduced motion, offline/storage failure, stale receipt handling, local/planner/escalation timelines, pack/sync lock states, secret rejection, namespace isolation, and no fake completion.

The browser is receipt-only: it defaults all facts to unobserved/unavailable, accepts only fresh digest-valid receipts, and exports command packets with `execution_claimed: false`.

### Lane 7 — hostile evaluation and final verification

Branch `agent/archie-hostile-evaluation` is **not complete**. At observed head `716bc2597439092ef5355dd6dc2bde5611fbd51f`, it only contains a temporary exact-tree snapshot workflow and temporary `package.json` source-export hacks. Do not admit these as final verification design.

Implement the leased evaluation files and matched repeated/novel fixtures. Compare no-memory, sparse specialists, CPU planner, teacher, and combined budget-controlled runtime. Detect miscalibration, over/under-escalation, false self-reports, stale evidence, tampering, secret leakage, regressions, and nondeterminism. Preserve every failed evaluation attempt.

## Coordinator drift and preserved evidence

Concurrent writes occurred. No force-push was used. Preserve these branches:

- `agent/archie-failed-unleased-pack`
- `agent/archie-handoff-contaminated-coordinator`
- `agent/archie-coordinator-drift-20260715`
- `agent/archie-coordinator-drift-20260715-b`
- `agent/archie-superseded-sync-admission`
- `agent/archie-coordinator-moved-6251b6f`

The current coordinator head `ba9a777504b96a49df29d2dac45988a3acbfb801` temporarily replaces `.github/workflows/maker-native-worker-ci.yml` with an exact-tree archive workflow. This was evidence infrastructure only. Replace it with the final verification workflow before completion.

A successful snapshot workflow on the hostile-evaluation branch was run as GitHub Actions run `29467963497`; artifact `8363657978` archived the exact checkout. It proved the artifact route works. The same mechanism should be used against the final coordinator head, then all actual tests must execute on that exact tree.

## Remaining work in order

1. Freeze one writer on `agent/archie-democratized-runtime`; preserve any new movement before continuing.
2. Obtain an exact coordinator checkout artifact and execute all admitted focused suites locally.
3. Repair and publish the #317 control-plane P0 findings, or fail the inherited platform seam closed with explicit audit evidence; do not silently trust the current head.
4. Verify/source-admit exact PR #324 worker-fleet files and tests.
5. Apply, inspect, and test the PR #325 27/27 repair bundle before admitting plugin files.
6. Re-run runtime-platform integration against the actual selected control/router/worker/plugin files with the required hostile seam tests.
7. Complete Lane 7 evaluation, hostile suite, audit manifests, package scripts, and final workflow.
8. Finish Lane 6 integration into `maker/maker.js`, `maker/maker.css`, and existing console phone tests only where genuinely required; avoid duplicate browser implementations.
9. Add the layperson README/product explanation. Explain: local sparse memory handles recurring tasks cheaply; the CPU planner composes known skills; a teacher handles novelty; lessons become owned memory; encrypted sync lets devices share it without relay plaintext; opportunistic hardware is used only when evidenced; neural distillation remains a separately admitted future hardware/data/evaluation project.
10. Run every required final command, inspect the complete base diff, push exact candidate, wait for every applicable exact-head workflow, and record run IDs and actual conclusions.
11. Open exactly one mergeable draft PR from coordinator to `agent/archie-linux-corpus`. Merge only after exact-head review and successful required checks. Do not deploy.

## Required final commands

- `node --check` for every changed/new module
- parse every new JSON Schema
- each focused Archie suite individually
- selected control/router/worker/plugin suites
- runtime-platform integration and hostile seam suite
- real Chromium phone proof
- `npm run test:maker`
- `npm run verify:repository`
- `git diff --check`
- inspect complete diff from `323e9d0b047284123ba1db1f3717d9ed22b5cb31`

Confirm no undeclared files, duplicate implementation, secrets, generated artifacts, fake receipts, unsupported neural/frontier/GPU/deployment claims, or unobserved cost/hardware claims.

## Final PR body requirements

Include base SHA, exact final head, every changed path, each source branch/head, rejected paths/claims, focused commands/counts, `test:maker`, `verify:repository`, exact-head workflow run IDs/conclusions, preserved branches, rollback instructions, browser/external unobservable facts, and explicit no-deployment statement.

## Current truth

No merge or deployment occurred during this handoff. The final PR has not yet been created. The coordinator is not terminal or green. The largest unresolved risk is inherited runtime composition authority: unsafe #317/#325 sources must not be smuggled through a green Archie-only suite.
