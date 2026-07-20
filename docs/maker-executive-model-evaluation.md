# Maker executive model execution and evaluation

Issue: #679  
Stacked dependency: PR #683 at `102976cd52d93d877541b9986fd0b447d2d43cee`

## Purpose

`scripts/maker-executive-model-evaluation.mjs` defines exact identity, provenance, fusion, quantization, frozen evaluation, device evaluation, and promotion contracts for trained artifacts.

It does not run a trainer or evaluator. It admits or rejects the receipts produced by those lanes and keeps every produced model in `promotion:not-admitted` until independent evidence satisfies the complete promotion contract.

## Dataset and trajectory identity

A dataset identity binds:

- exact content digest;
- byte and record counts;
- schema digest;
- optional tokenizer digest.

A trajectory binds the dataset, repository source SHA, prompt bytes, chosen output, optional rejected output, causal-pair identity, and lineage. Every normalized identity receives its own deterministic digest.

## Per-shard adapter receipts

Each training shard must prove:

- exact source SHA;
- exact frozen-base checkpoint;
- exact dataset and trajectory identities;
- adapter artifact digest;
- changed-tensor digest and a positive changed-tensor count;
- training steps;
- bounded reliability evidence.

A shard receipt with zero changed tensors is rejected. Every accepted shard receipt remains `promotion:not-admitted`.

## Reliability-weighted fusion

Fusion accepts only shard receipts with the same source SHA, base checkpoint, and dataset. Reliability weights must be positive and are normalized across the admitted components. The fused adapter identity binds every component adapter, changed-tensor proof, and weight.

Fusion does not promote a model.

## Frozen-base and fused non-regression

`compareFrozenBase` requires identical case identities for baseline and candidate. It records case-level gains and regressions by capability, severity, and reproducibility. Any baseline pass that becomes a candidate failure prevents a non-regression claim.

Merged-checkpoint materialization is denied until every declared fusion gate and the fused-adapter non-regression comparison pass.

## Bounded recursive failure-set training

Recursive training consumes only reproducible failed cases, binds the exact source and dataset, limits selected case count and training steps, and increments a predeclared recursion depth. Training is denied at the evaluator-selected recursion limit. Resulting plans remain non-admitted.

## Quantization and local execution

Quantization comparison preserves:

- exact candidate digest and format;
- bytes and peak RAM;
- exact evaluated and retained case counts;
- case-level failures.

The selected candidate must satisfy both minimum retention and RAM gates. Among eligible candidates the smallest artifact wins, followed by retention and deterministic identity.

GGUF verification checks file and metadata digests, expected architecture, model type, tensor count, and required metadata. RAM-capped execution plans account for model bytes, runtime overhead, context, and KV cache and return exact headroom or deficit.

## Frozen evaluation isolation

A frozen evaluation contract binds:

- frozen-suite, prompt, dataset, baseline, and candidate digests;
- distinct trainer and evaluator identities;
- only the artifact digests the evaluator may access;
- minimum case count;
- minimum Wilson confidence lower bound.

Metrics are rejected when any observed bytes differ, the evaluator accesses undeclared training outputs, evidence is too small, or confidence is below the threshold. Case-level outputs and per-capability totals are retained.

## Adversarial and device evaluation

Discovered failure clusters generate bounded adversarial cases across capability/cluster groups rather than repeating only the aggregate suite.

Device profiles independently gate runtime, peak memory, p95 latency, and thermal limits for each declared device identity.

## Promotion

Promotion requires:

- admitted frozen-suite metrics;
- non-regression evidence;
- every required model gate;
- all declared device profiles passing;
- exact baseline, candidate, suite, and dataset identities.

Missing or failed evidence produces explicit rejection reasons and `promotion:not-admitted`. `promotion:admitted` is returned only when the complete deterministic contract passes; it is not deployment authority.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-model-evaluation.test.mjs
```

The isolated contract passed ten cases before repository mutation, covering:

- dataset, tokenizer, trajectory, causal-pair, and lineage identity;
- changed-tensor shard proof;
- reliability-weighted identity-matched fusion;
- case-level frozen-base gains and regressions;
- bounded reproducible failure-set recursion;
- fusion-gated merged-checkpoint materialization;
- quantization retention and RAM selection;
- GGUF architecture/metadata and local RAM compatibility;
- evaluator isolation, frozen-byte matching, minimum evidence, and confidence intervals;
- adversarial failure clusters;
- device runtime, memory, latency, and thermal gates;
- fail-closed promotion decisions.

PR #683's independent repository workflows completed successfully before this stacked branch was created.

## Claim boundary

This lane defines model and evaluation receipts. It does not yet admit:

- actual dataset collection or trainer execution;
- physical trainer/evaluator isolation;
- tensor arithmetic or checkpoint serialization;
- quantizer or GGUF converter execution;
- device benchmark execution;
- integration, release, deployment, remote coordination, or generation terminalization.

Those remain dependent lanes in #679. A model promotion decision never grants build, merge, or deployment authority.
