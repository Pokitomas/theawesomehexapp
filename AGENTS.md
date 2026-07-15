# Sideways engineering contract

This repository is operated from evidence, not from issue activity or optimistic product claims.

## Default Maker entrypoint

For broad implementation work, run:

```bash
npm run maker -- "describe the end state"
```

Maker performs four parallel read-only assessments, synthesizes one highest-leverage lane, acquires an exclusive path lease in a draft pull request, waits for the read-only Actions collision gate, and then gives exactly one isolated worktree to one writer. The writer must run focused tests and `npm run verify:repository`. Merge and deployment remain human actions.

## Assessment before mutation

Before editing, inspect the current default-branch commit, repository architecture, tests, visible product state, runtime facts, and relevant open pull requests. Separate code-local opportunities from external configuration that the repository cannot prove.

The standard non-overlapping assessment wave is:

1. root reader to private archive product journey and frontend UX;
2. social authority to visible consumer reachability;
3. Maker, Codex, and coding-agent runtime ergonomics;
4. hostile security, testing, storage, network, and operations review.

Assessment agents are read-only. They do not create branches, edit files, or mutate GitHub.

## Collision discipline

- One session has exactly one writer.
- The writer uses one dedicated git worktree and one `maker/*` branch.
- The draft PR body contains a machine-readable `sideways-maker-lease/v1` marker.
- Open Maker PR leases must not overlap by exact path or directory prefix.
- `**` is a repository-wide exclusive lock and should be used only when narrower ownership is impossible.
- Shared files such as `package.json`, repository verification manifests, authority projections, workflows, and generated kernel sources must be included in the lease when changed.
- Never permit two agents to edit the same worktree.

## Verification and receipts

Run the narrowest useful tests while implementing, then independently run:

```bash
git diff --check
node scripts/native-changed-check.mjs
npm run verify:repository
```

The final receipt names the exact head SHA, changed files, tests, remaining blockers, rollback notes, and draft PR. Do not describe a model claim as a passing test.

## Product and authority invariants

Preserve these distinct realities:

- the root reader and ranking laboratory;
- the user-owned private archive under `/manual/`;
- canonical public social authority only on a configured function deployment;
- rebuildable public projections and ranking candidate pools;
- repository coordination and Maker surfaces, which are not ordinary consumer product paths.

Do not silently copy public authority into private archives, treat caches as canonical state, claim static Pages can perform server mutations, or infer external runtime configuration from source code.

## Human-only authority

Coding agents may inspect and modify repository files inside their branch and worktree. They may not merge, deploy, force-push, alter secrets, register runners, mutate production data, change repository settings, or claim production readiness. Credentials never belong in prompts, issues, commits, artifacts, screenshots, or receipts.
