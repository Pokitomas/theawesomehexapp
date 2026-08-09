# Sideways engineering contract

This repository is operated from evidence, not from issue activity or optimistic product claims.

Terminology follows `ENGINEERING_LANGUAGE.md`: describe mechanisms and bounded effects in active prose. Existing schema names, environment variables, paths, and serialized compatibility fields remain unchanged unless an explicit migration changes them safely.

## Default operating mindset

Future coding models should treat this repository as a living engineering system, not as a museum of prior ideas.

- Prefer the **current executable dependency graph** over historical names, prose, issue narratives, or old architecture claims.
- Before deleting or replacing anything, **read the exact file first, inspect references, and preserve any unique result, hash, falsifier, receipt, or engineering lesson** in compact evidence. Do not delete by filename or theme alone.
- Keep the repository small. If two mechanisms do the same job, retain the one that is current, simpler, better tested, or more directly connected to production and collapse the duplicate.
- Preserve negative evidence. A failed experiment, rejected candidate, numerical defect, or blocked deployment can be more valuable than another implementation branch.
- Separate **model code, trainer, evaluation, transport, product UI, evidence, and historical research**. Similar naming does not imply shared function.
- Treat tests as witnesses, not truth by definition. If the implementation claims to realize a mathematical recurrence, compare it against the defining sequential/reference behavior, not only finite outputs or passing gradients.
- Prefer direct measurement over architecture storytelling. A speedup is a speedup; admission requires fidelity. A numerical degeneracy is a numerical degeneracy until stronger meaning is independently established.
- For precision-sensitive work, keep a strict reference lane. Near-singular, cancellation-heavy, quaternion/Heisenberg, or similar numerical checks should use FP32/FP64 references with TF32 disabled where appropriate and report tolerances, singular values, conditioning, or explicit error bounds.
- Do not let one failed interface redefine system health. Distinguish transport failure, controller failure, trainer failure, evaluation rejection, and model failure.
- Fix the highest-leverage observed defect first. Do not manufacture speculative work to stay busy.
- Prefer one durable mechanism plus receipts over many wrappers, dashboards, schemas, and prose layers around the same mechanism.
- Keep language ordinary and concrete: worker, controller, evaluation gate, receipt, checkpoint, permission scope, transport, admission status, numerical stability, reproducibility.
- Compatibility identifiers may remain weird. Do not break wire formats merely to make names prettier.
- When historical context is needed, read `ARCHIE_HISTORY_COMPACT.md` and `EVIDENCE.md`; do not resurrect retired code merely because an old document sounds ambitious.
- When the live machine and GitHub disagree, the **live executable source plus exact hashes and receipts** is the stronger claim about current behavior. GitHub should be reconciled to it, not vice versa.
- Do not claim completion, capability, admission, or production health without an observable witness.

The desired style is: inspect deeply, mutate decisively, keep only what earns its place, preserve evidence, and leave the system easier for the next engineer to understand than it was before.

## Default Maker entrypoint

For broad implementation work, run:

```bash
npm run maker -- "describe the end state"
```

Maker performs four parallel read-only assessments, synthesizes one highest-leverage lane, acquires an exclusive path lease in a draft pull request, waits for the read-only Actions collision gate, and then gives exactly one isolated worktree to one writer. The writer must run focused tests and `npm run verify:repository`. Merge and deployment remain human actions.

## Assessment before mutation

Before editing, inspect the current default-branch commit, repository architecture, tests, visible product state, runtime facts, and relevant open pull requests. Separate code-local opportunities from external configuration that the repository cannot prove.

The standard non-overlapping assessment wave is:

1. root reader: private archive product journey and frontend UX;
2. public-state assessment: visible consumer reachability;
3. Maker, Codex, and coding-worker runtime ergonomics;
4. security robustness, testing, storage, network, and operations review.

Assessment workers are read-only. They do not create branches, edit files, or mutate GitHub.

## Collision discipline

- One session has exactly one writer.
- The writer uses one dedicated git worktree and one `maker/*` branch.
- The draft PR body contains a machine-readable `sideways-maker-lease/v1` marker.
- Open Maker PR leases must not overlap by exact path or directory prefix.
- `**` is a repository-wide exclusive lock and should be used only when narrower ownership is impossible.
- Shared files such as `package.json`, repository verification manifests, permission projections, workflows, and generated kernel sources must be included in the lease when changed.
- Never permit two workers to edit the same worktree.

## Verification and receipts

Run the narrowest useful tests while implementing, then independently run:

```bash
git diff --check
node scripts/native-changed-check.mjs
npm run verify:repository
```

The final receipt names the exact head SHA, changed files, tests, remaining blockers, rollback notes, and draft PR. Do not describe a model claim as a passing test.

## Product and permission/state invariants

Preserve these distinct realities:

- the root reader and ranking laboratory;
- the user-owned private archive under `/manual/`;
- canonical public state only on a configured function deployment;
- rebuildable public projections and ranking candidate pools;
- repository coordination and Maker surfaces, which are not ordinary consumer product paths.

Do not silently copy canonical public state into private archives, treat caches as canonical state, claim static Pages can perform server mutations, or infer external runtime configuration from source code.

Compatibility identifiers containing `authority` may remain in existing APIs, schemas, migrations, or file names; in active explanatory prose they mean a specific permission scope or canonical-state responsibility, not autonomous power.

## Human-only permissions

Coding workers may inspect and modify repository files inside their branch and worktree. They may not merge, deploy, force-push, alter secrets, register runners, mutate production data, change repository settings, or claim production readiness. Credentials never belong in prompts, issues, commits, artifacts, screenshots, or receipts.
