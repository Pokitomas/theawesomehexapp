# Archie information-budgeted RSLoRA elastic evidence graph

## Purpose

This document defines the bounded external-compute successor to the canonical information-budgeted RSLoRA lane in issue #721.

It does **not** reinterpret any existing training receipt as success. It changes the execution system so future specialist training can survive preemption, move across compatible GPU workers, and preserve sub-epoch evidence.

## Why the current workflow is not yet elastic

The current workflow (`.github/workflows/archie-information-budgeted-rslora.yml`) already segments pairs, caches frozen-base reference scores, trains two rank-32 specialists, fuses verified adapters, and evaluates against the exact frozen base.

Its systems boundary is still brittle:

```text
one long specialist job
→ 720 minute timeout
→ no declared sub-epoch resume contract
→ worker death can discard partial progress
```

That is a compute-allocation problem before it is a model-design problem.

## Successor execution shape

The successor lane is an evidence graph, not a single monolithic run:

```text
immutable campaign capsule
  → CPU segmentation + shard receipts
  → frozen-base reference cache receipts
  → bounded specialist rungs
  → immediate rung upload
  → resume on any compatible worker
  → frozen specialist gate
  → exact fusion
  → frozen fused gate
  → quantization retention
  → clean-environment reproduction
```

A rung is a bounded optimizer-step or information-token interval. Worker death may lose at most one rung.

## Resume contract

Every rung checkpoint must preserve enough state to continue training without silent drift:

```text
adapter weights
optimizer state
scheduler state
mixed-precision scaler state when present
Python RNG
Torch RNG
CUDA RNG
sampler position
consumed pair IDs or equivalent deterministic cursor
exact next optimizer step
```

Resume identity must bind:

```text
repository SHA
profile digest
model directory digest
tokenizer digest
dataset receipt digest
reference-cache digest
training package versions
prior checkpoint digest
next optimizer step
```

If any bound identity changes, resume must refuse.

## Required artifacts per rung

Each rung publishes a receipt bundle immediately after completion:

- rung request;
- checkpoint digest inventory;
- optimizer-step interval;
- consumed-example interval or deterministic cursor;
- GPU type and runtime details;
- loss summary and nan/inf status;
- changed-tensor digest comparison against rung start;
- upload receipt and artifact digest.

A partial or failed rung is valid evidence and must remain visible.

## Canonical first implementation scope

The first elastic implementation remains intentionally narrow:

1. Preserve the current canonical two-specialist rank-32 lane.
2. Keep segmentation and frozen-base reference caching source-compatible with the current workflow.
3. Add bounded rung planning and receipt emission before any adaptive expansion.
4. Require each specialist to pass the exact frozen non-regression gate before fusion.
5. Keep fused evaluation and quantization retention unchanged in principle.

Do not expand rank, shard count, or providers until two canonical specialists produce valid changed-tensor and frozen-comparison receipts.

## Adversarial resume tests

The successor is incomplete until it proves resume integrity under disruption:

- resume on the same worker after intentional interruption;
- resume on a different compatible worker;
- refuse resume when the repository SHA changes;
- refuse resume when the dataset or cache digest changes;
- refuse resume when the checkpoint lineage is broken;
- refuse resume when the next-step cursor is inconsistent.

These are correctness gates, not optional hardening.

## Economic reporting

Every measured candidate should report gain relative to the frozen base per:

- GPU-second;
- information token;
- processed attention area;
- dollar, when provider billing is available;
- joule estimate, when available.

The point is adaptive evidence allocation, not undifferentiated brute force.

## Truth boundary

```text
More timeout is not elasticity.
A restarted run without optimizer/RNG continuity is not resume.
Changed tensors are not capability improvement.
A fused artifact is not admission.
A provider-specific success is not independent reproduction.
```

Until real rung receipts, frozen comparisons, quantization retention, and clean-environment reproduction exist, the correct promotion remains:

```text
not-admitted
```
