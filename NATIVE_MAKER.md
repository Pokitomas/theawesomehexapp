# Maker runtime

Maker is now split into two parts:

- **local intelligence**: Codex or another user-selected coding agent receives the full repository checkout and terminal inside isolated git worktrees;
- **GitHub Actions control**: open-PR path leases prevent writer collisions and four read-only verification lanes run in parallel.

The default path does not require a hosted model endpoint, a model API key in GitHub, or a self-hosted Actions runner.

## Use it

From a clean checkout:

```bash
npm ci --ignore-scripts
npm run maker -- "complete the remaining product path end to end"
```

The default adapter is Codex CLI. Install and authenticate it locally, then authenticate GitHub CLI:

```bash
npm install -g @openai/codex
codex login
gh auth login
```

Maker checks both sessions before doing work. The user-facing interface remains one request string; the orchestration is automatic.

## What one run does

1. Fetches `origin` and binds the run to an exact default-branch SHA.
2. Starts four read-only agents in parallel:
   - product journey and frontend UX;
   - social API to visible-product reachability;
   - Maker and coding-agent runtime;
   - hostile full-stack, security, test, and operations review.
3. Runs one read-only integrator that selects the highest-leverage code-local lane and the smallest plausible path lease.
4. Creates one `maker/*` branch and one isolated worktree.
5. Pushes a temporary lease commit and opens a draft PR before implementation.
6. Waits for `.github/workflows/maker-sprawl.yml` to compare the lease against every other open Maker PR.
7. Gives exactly one writer workspace-write authority in the isolated worktree.
8. Runs `git diff --check`, `scripts/native-changed-check.mjs`, and `npm run verify:repository` independently of the agent.
9. Commits and pushes only a verified patch, updates the draft PR receipt, and waits for the final Actions sprawl run.

A failed run preserves its worktree, branch, and draft PR when available so recovery does not destroy evidence.

## Collision model

Every draft Maker PR contains a hidden `sideways-maker-lease/v1` JSON marker. The marker includes:

- exact base SHA;
- session and branch identity;
- one selected implementation lane;
- repository-relative owned paths;
- `writer_count: 1`;
- human-only merge and deployment authority.

Paths are exclusive by exact file or directory prefix. `src` collides with `src/app.mjs`; `src` does not collide with `scripts`; `**` collides with everything. The Actions gate has read-only repository and pull-request permissions and cannot merge or mutate code.

Open Maker PRs are the live lease table. Closing a PR releases its lease.

## Actions sprawl

After collision admission, Actions fans out four independent witness lanes:

- product: human-quality verification;
- social: social-memory and reachability tests;
- operator: native worker plus Maker orchestrator tests;
- hostile: workflow permissions, supply chain, and operations reality.

The ordinary repository gate remains the final exact-tree verifier. Actions coordinates and verifies sprawl; it does not host the primary engineering model.

## Codex adapter

Maker uses stable non-interactive Codex execution:

- read-only assessment agents run with a read-only sandbox;
- the sole writer runs with a workspace-write sandbox;
- approval prompts are disabled for the unattended invocation;
- structured assessment and planning outputs use JSON schemas;
- prompts are sent on stdin and final receipts are written to files.

Codex authentication remains on the user's computer. It is not copied into GitHub Actions.

## Any-agent adapter

A different coding agent can be used without adding a provider SDK:

```bash
MAKER_AGENT_COMMAND_JSON='["your-agent","--workspace","{workspace}","--output","{output}"]' \
  npm run maker -- --agent command "complete the request"
```

The command is a JSON argv array, never a shell string. Maker sends the prompt on stdin and provides:

- placeholders: `{workspace}`, `{output}`, `{schema}`, `{role}`;
- environment: `MAKER_WORKSPACE`, `MAKER_OUTPUT`, `MAKER_SCHEMA`, `MAKER_ROLE`, `MAKER_SANDBOX`.

Read-only roles must return JSON matching the supplied schema. The writer may use the repository terminal and leave the completed patch in its worktree.

## Local-only escape hatch

`--local-only` skips push, draft PR creation, and the Actions collision gate. It exists for offline experiments, but it does not provide cross-machine collision protection and is not the default.

`--dry-run` completes the four assessments and synthesis without creating a branch.

## Issue-triggered native worker

Owner-authored `[maker:*]` issues also activate a constrained GitHub Actions worker. With no repository model mode configured, it uses GitHub Models through the run-scoped `GITHUB_TOKEN`, the official `models: read` permission, the OpenAI-compatible inference endpoint, and the default `openai/gpt-4.1` model. No separate model secret or self-hosted runner is required.

Set `SIDEWAYS_MODEL_MODE=hosted` to use an explicitly configured OpenAI-compatible endpoint, or `SIDEWAYS_MODEL_MODE=self-hosted` to use a `sideways-maker` runner and an Ollama-compatible endpoint. `SIDEWAYS_MODEL_MODE=github-models` explicitly selects the zero-configuration path. Unsupported non-empty modes fail closed with an issue receipt.

The issue worker deliberately exposes a small fixed tool surface and always checks out trusted default-branch code before gaining write authority. Its GitHub token may create a branch, commit, draft PR, issue receipts, and a non-secret episode artifact; merge and deployment remain human authority.

## Model improvement boundary

Maker records structured assessments, plans, leases, test evidence, and final receipts. That material can support later evaluation or distillation, but Maker does not pretend to train a new RWKV-style or hybrid foundation model during an ordinary repository run. Weight training requires separately admitted data policy, model code, compute, evaluation, and artifact authority.

## Authority

Maker may create branches, commits, draft PRs, and local temporary worktrees. Human review, merge, deployment, secrets, production data, runner registration, and repository settings remain outside its authority.
