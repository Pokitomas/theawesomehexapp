# Swarm Integration Planner

This lane adds a deterministic, read-only composition planner for concurrent pull requests. It does not fetch GitHub data, modify branches, merge, deploy, approve workflows, install dependencies, or spend compute. A coordinator supplies one explicit snapshot of the live PR graph; the planner validates that snapshot and emits a machine-readable integration receipt.

## Why this exists

A green result on several isolated pull-request heads does not prove that their combined tree is valid. Shared files may have different valid edits, a branch may have moved since its receipt, a lease may not cover its changed paths, or a supposedly independent writer may duplicate another lane.

The planner keeps those facts explicit. It distinguishes:

- an independent candidate that can be reviewed separately;
- a collision component with one declared composition target;
- an unresolved component with no unique coordinator target;
- a held writer with stale base, missing lease, requested changes, failed or action-required CI, or non-exact verification;
- and a global dependency cycle.

It never performs the composition itself. Merge and deployment authority remain human.

## Run

```bash
node scripts/swarm-integration-plan.mjs \
  --input /path/to/swarm-snapshot.json \
  --output /tmp/swarm-plan.json
```

Omit `--output` to print the plan to standard output. The output file is created with an exclusive-write flag and will not silently overwrite an existing receipt.

Exit codes:

- `0` — input is valid and all admissible collision components have one declared composition target;
- `2` — input is valid but at least one PR, dependency cycle, or overlap component is held;
- `1` — malformed or unsafe input.

Focused tests:

```bash
node --check scripts/swarm-integration-plan.mjs
node --test scripts/tests/swarm-integration-plan.test.mjs
```

## Snapshot schema

The root schema is `sideways-swarm-snapshot/v1`.

```json
{
  "schema": "sideways-swarm-snapshot/v1",
  "repository": "Pokitomas/theawesomehexapp",
  "base_branch": "main",
  "base_sha": "exact-main-sha",
  "prs": [
    {
      "number": 251,
      "title": "Complete Maker",
      "branch": "maker/complete-maker",
      "head_sha": "exact-pr-head",
      "base_sha": "exact-main-sha",
      "state": "open",
      "draft": true,
      "role": "maker",
      "composition_target": true,
      "depends_on": [249, 250],
      "changed_paths": ["package.json", "scripts/maker.mjs"],
      "lease": {
        "owned_paths": ["package.json", "scripts/maker.mjs"],
        "writer_count": 1,
        "base_sha": "exact-main-sha",
        "authority": {
          "merge": "human",
          "deploy": "human"
        }
      },
      "ci": {
        "status": "success",
        "exact_head": true,
        "run_count": 20
      },
      "review_status": "none"
    }
  ]
}
```

Managed `agent/`, `maker/`, and `copilot/` branches fail closed without a lease. Only exact paths, directory prefixes, and terminal `/**` claims are accepted. Absolute paths, traversal, arbitrary wildcard syntax, widened merge/deploy authority, and secret-like fields are rejected.

## Plan schema

The output schema is `sideways-swarm-integration-plan/v1`. It includes:

- a deterministic SHA-256 digest of the normalized snapshot;
- admissible and held PR numbers;
- exact blocker codes;
- changed-path and lease overlaps;
- dependency-cycle blockers;
- ordered stages;
- and immutable coordinator rules.

Stage types:

- `independent_candidate` — no overlap with another admissible PR;
- `coordinator_compose` — an overlap component with exactly one `composition_target`;
- `coordinator_hold` — an overlap component with zero or multiple composition targets;
- `held_recovery` — PRs excluded until their blockers are cleared.

A moved head or moved base invalidates the prior snapshot and plan. Generate a new snapshot and receipt rather than editing the old one.

## Current constellation witness

The focused suite serializes the observed #249–#253 graph as a hostile fixture. It proves the expected topology without mutating those branches:

1. #252 remains an independent Foundry candidate.
2. #249 and #250 are predecessor deltas for coordinator composition into #251 because `package.json`, `.github/workflows/maker-native-worker-ci.yml`, and `audit/authority-manifest.workflow-projection.mjs` are shared.
3. #253 remains held while it has requested changes, action-required workflows, a missing lease, and collisions with the canonical Foundry and shared package surface.

That fixture is evidence about the planner, not permanent authority over those PRs. Any changed head requires a fresh live snapshot.

## Authority boundary

The planner may recommend a composition stage. It cannot:

- merge or rebase a branch;
- update a ref;
- choose the semantic winner for a shared-file conflict;
- approve or rerun a workflow;
- infer successful CI from prose;
- treat orchestration as a native-model result;
- or replace exact-head repository verification after the combined tree exists.

The coordinator must compose shared files once, inspect the resulting diff, run focused witnesses and `npm run verify:repository`, and record the exact resulting head before human review.
