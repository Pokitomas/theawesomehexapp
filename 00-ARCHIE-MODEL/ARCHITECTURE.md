# Archie architecture status

No neural architecture is named canonical by this document right now.

## Retired lane

The previous canonical description was:

```text
Qwen3-1.7B
+ verified failed→repair causal pairs
+ information-budgeted replay around first divergence
+ two rank-32 RSLoRA specialists
+ exact scale-aware fusion to rank 64
+ full-sequence frozen-base evaluation
```

That lane had useful engineering ideas, especially supervision around the causal fork, lineage-atomic work balancing, frozen-reference caching, and mathematically correct delta-space LoRA fusion. Historical bounded CPU evidence is preserved in `evidence/HOSTED-LINUX-CPU-RSLORA.json`.

It is retired as the current architecture because the default branch no longer contains the implementation paths the old package named as executable. Architecture identity cannot survive deletion of its implementation by prose alone.

## Current reconstruction rule

Establish the next architecture only from:

```text
live trainer process / exact run receipt
→ trainer source
→ direct imported model-core source
→ direct state/memory dependencies
→ exact configuration and parameterization
→ frozen evaluation protocol
```

Separate executable courts, compilers, obligation systems, UIs, historical experiments, and transport code must not be described as neural forward-path components unless the live dependency graph proves they are.

## Admission boundary

Code existence is not capability. Changed tensors are not quality. A historical receipt is not a current architecture. Promotion remains `not-admitted` until the current candidate has exact training, held-out, retention, and reproduction evidence.
