# Sideways agent operating contract

This file governs repository-local coding agents. It does not grant merge, deployment, secret, runner, database, or hosting authority.

## Start from reality

Before editing:

1. run `git status -sb`, `git fetch origin --prune`, and compare `HEAD` with `origin/main`;
2. inspect `README.md`, `PROGRAM_ONTOLOGY.md`, `NATIVE_MAKER.md`, `package.json`, and the files directly relevant to the task;
3. inspect live issues, pull requests, and exact-head CI when GitHub access is available;
4. separate code-local work from external facts that the repository cannot prove.

A quiet issue/PR list is not evidence that the product, runtime, database, backup, or accessibility work is complete.

## Assessment before delegation

For broad or full-stack work, complete one read-only architecture assessment before spawning subagents. Then delegate independent read-heavy lanes. The default assessment wave is:

- root reader → private archive product journey;
- public social authority → visible consumer reachability;
- native Maker/Codex operator activation;
- hostile tests, security, operations, accessibility, network, and storage behavior.

Wait for all lane reports and synthesize one prioritized plan before mutation.

## Parallelism boundary

Subagents are read-only by default. Never permit two agents to edit the same working tree.

Use one primary writer for the selected lane. A second writer requires a separate branch and git worktree with explicitly non-overlapping owned paths. Shared files such as `package.json`, authority manifests, workflows, generated kernel sources, and repository verification maps belong to the coordinator unless ownership is explicitly transferred.

## Branch and evidence discipline

- Create implementation branches from current `origin/main` using `agent/<bounded-description>`.
- Preserve unrelated concurrent changes; never force-push over moved work.
- Add or strengthen executable witnesses for behavior changes.
- Run focused tests first, then `npm run verify:repository` before a draft-PR-ready receipt.
- A final receipt names exact HEAD, changed files, commands and results, remaining blockers, and rollback notes.

## Product and authority invariants

Preserve these distinct realities:

- the root reader and ranking laboratory;
- the user-owned private archive under `/manual/`;
- the canonical public social authority available only on a configured function deployment;
- rebuildable public projections and ranking candidate pools;
- repository coordination and Maker surfaces, which are not ordinary consumer product paths.

Do not silently copy public authority into the private archive, treat cached projections as canonical state, claim static Pages can perform server mutations, or infer external runtime configuration from repository code.

## Prohibited without explicit human authority

Do not merge, deploy, enable auto-merge, change secrets, register runners, mutate production databases, alter hosting configuration, weaken workflow/authority controls, or claim production readiness. Do not put credentials or registration tokens in issues, commits, artifacts, screenshots, or transcripts.

## Terminal takeover

Run `npm run agent:takeover` to inspect the local checkout and emit the canonical assessment-first Codex prompt. The prompt authorizes read-only subagent assessment followed by one bounded writer; it does not authorize merge or deployment.
