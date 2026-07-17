# Archie native workspaces

Archie workspaces are the provider-neutral task, run, artifact, review, evidence, promotion, and rollback substrate. They do not replace source hosting. GitHub can be an import/export adapter, but no GitHub account, repository, issue, pull request, token, or network route is required for local operation.

## Canonical objects

A workspace owns objectives, task graphs, agent identities, capability grants, one-writer task leases, runs, append-only run events, digest-bound artifacts, independent evidence, reviews, requested changes, approvals, promotion decisions, publications, and rollback receipts.

Every mutation is an `archie-workspace-event/v1` record with:

- monotonically increasing sequence;
- previous-event digest;
- canonical payload digest;
- complete event digest;
- actor identity and timestamp.

The file provider stores one verified JSONL event stream per workspace and content-addressed artifact bytes outside Git. The memory provider implements the same adapter contract for tests and embedding. A different database, object store, or service can implement the same `readEvents`, `appendEvent`, `listWorkspaceIds`, `putArtifact`, and `readArtifact` methods.

## Local service

```bash
archie workspace serve
```

The default service binds to `127.0.0.1:8787` and stores state under `~/.archie/workspaces`.

```text
GET  /.well-known/archie-workspace-service.json
GET  /v1/workspaces
POST /v1/workspaces
GET  /v1/workspaces/:workspace_id
GET  /v1/workspaces/:workspace_id/events
POST /v1/workspaces/:workspace_id/commands
GET  /v1/workspaces/:workspace_id/artifacts/:artifact_id
GET  /v1/workspaces/:workspace_id/results/latest
```

Public workspaces allow anonymous reads. Private and locally sealed workspaces require a principal with read authority. Local mutations use `x-archie-principal` only on loopback. This is an identity seam for the local provider, not an internet authentication claim. A remotely exposed deployment must inject an authenticator; non-loopback writes fail closed without one.

## Simple local journey

```bash
archie workspace demo
archie workspace list
archie workspace inspect <workspace_id>
```

The demo executes the complete native lifecycle:

1. create a public workspace;
2. define an objective, protected reality, and proof of done;
3. create a task graph;
4. register an execution agent, reviewer, and policy principal;
5. issue explicit capability grants;
6. claim one mutable task lease;
7. produce an artifact;
8. receive an independent requested change;
9. repair and reproduce the artifact;
10. resolve the change and receive approval;
11. record independent passing evidence;
12. approve promotion;
13. publish a stable result URL;
14. record a rollback receipt.

## Commands

```bash
archie workspace init \
  --title "My workspace" \
  --visibility public \
  --owner owner_local

archie workspace command <workspace_id> \
  --principal owner_local \
  --type objective.define \
  --payload-json '{"statement":"Ship the verified result","protected_reality":"Do not expose secrets","proof_of_done":"Tests and artifact receipt"}'
```

Use `--payload-file` for larger command payloads.

## Authority

The workspace owner may issue and revoke grants. Agent grants are explicit and may contain `read`, `write`, `run`, `contact`, `spend`, `deploy`, `plan`, `review`, and `approve`. Task-scoped grants do not flow to other tasks. A task has at most one active mutable lease. Producing agents cannot independently review or evaluate their own run.

Promotion fails unless the selected run is completed, the selected artifact belongs to it, every requested change is resolved, an independent reviewer approved that artifact, and independent passing evidence exists. Publication additionally requires deploy authority. No interface may infer those states from prose or styling.

## Schemas

- `maker/contracts/archie-workspace.schema.json`
- `maker/contracts/archie-objective.schema.json`
- `maker/contracts/archie-task.schema.json`
- `maker/contracts/archie-run.schema.json`
- `maker/contracts/archie-artifact.schema.json`
- `maker/contracts/archie-review.schema.json`
- `maker/contracts/archie-workspace-event.schema.json`

## Verification

```bash
npm run test:archie:workspace
npm run verify:repository
```

Green substrate tests prove event integrity, local persistence, authority enforcement, review and promotion gates, anonymous public reads, and artifact retrieval. They do not prove model intelligence or production internet authentication.
