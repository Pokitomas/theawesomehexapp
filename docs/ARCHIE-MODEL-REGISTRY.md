# Archie model registry

`MODEL_REGISTRY.json` is the authority for distinguishing Archie artifacts.

## Naming rule

**Archie** names the complete system. Neural and symbolic artifacts use explicit IDs.

Examples:

```text
archie-lm-114m-v1
archie-register-v4
archie-world-executor-v1
archie-qwen-rslora-v1
archie-repo-policy-v1
```

A pull request must not call a new experiment “Archie” without naming the exact artifact it modifies or creates.

## Claim isolation

An artifact may claim only evidence recorded in its own registry entry.

It may not inherit another artifact's:

- weights or checkpoint lineage;
- parameter count;
- training tokens or optimizer steps;
- evaluation metrics;
- admission state;
- deployment status;
- architecture claims;
- capability language.

Infrastructure, schemas, workflows, corpus plans and receipts are not model weights. A runnable trainer is not a trained model. A preflight is not an optimizer update. Lower loss is not agency.

## Required fields

Each entry records:

- physical weight existence and location class;
- exact weight SHA-256 when known;
- initialization origin;
- architecture and parameter count;
- objective;
- optimizer steps and token exposure;
- directly measured capability;
- status and promotion boundary;
- source branch or pull request;
- predecessor and successor relationships;
- blocking issues.

`null` means the value has not been normalized or verified. It does not grant permission to infer the missing value.

## Lifecycle

Use these status classes consistently:

```text
planned-blocked
executable-experiment-preflight-blocked
research-only-not-admitted
archival-research-only
superseded-research-only
admitted-narrow-component
```

A planned entry must not claim existing weights. A research entry does not become admitted because its branch is large, its workflow passes, or its documentation is detailed.

## Current execution order

1. #733 — extract the exact `archie-lm-114m-v1` code, install fixed evaluation and continue the unchanged baseline.
2. #734 — test linked recurrent state and incremental SSM/KV inference against reset and transplanted-state controls.
3. #735 — test Event Clock only if recurrence survives falsification.

PR #697 remains immutable historical world-executor evidence. PR #727 remains draft transport infrastructure for an unproduced RSLoRA adapter. PRs #729, #730 and #732 are closed but preserved as research branches.

## Validation

Run:

```bash
node scripts/verify-model-registry.mjs MODEL_REGISTRY.json
```

The dedicated GitHub workflow runs the same validator whenever registry authority changes.
