# Archie budgeted neural training design

## Current artifact state

This repository still does **not** contain a trained neural Archie artifact. There is no constructed neural checkpoint, changed LoRA adapter, fused model, or quantized trained Archie to publish. The repository contains executable training and verification code only.

A publishable candidate still requires all of the following receipts and evidence:

```text
actual CUDA gradient steps
changed adapter tensors
exact base-model and dataset digests
training receipt
held-out frozen-base comparison
fused-model evaluation
quantization retention results
independent admission decision
```

## Cost analysis of the previous path

The original causal-divergence trainer performed these model passes for each preference batch:

```text
chosen policy
rejected policy
chosen frozen reference
rejected frozen reference
```

The segmented pipeline also copied the common global held-out split into every specialist and ran inline evaluation before the mandatory external verifier repeated the frozen-base comparison. Token-balanced sharding was sound, but the trainer still spent equal gradient compute on low-information tails and every admitted lineage.

## Brainstormed options

The design review considered:

1. smaller base checkpoint;
2. fewer shards;
3. lower LoRA rank;
4. sequence packing;
5. prefix KV reuse;
6. reference-logit caching;
7. reference-free preference optimization;
8. lineage-level token budgeting;
9. post-divergence tail caps;
10. sparse module targeting;
11. rank-stabilized LoRA;
12. DoRA or module-specific rank patterns;
13. layer skipping;
14. online hard-example mining;
15. one final shared held-out evaluation instead of duplicated inline evaluation.

The rejected options were either weaker, incompatible with exact delta fusion, dependent on unpinned kernels, or likely to move cost into a new preprocessing stage without reducing total work.

## Selected design

The selected profile uses:

```text
Qwen3-1.7B frozen NF4 base
rank-24 rank-stabilized LoRA
attention projections: q/k/v/o
SwiGLU projections: gate/up/down
policy-only causal margin objective
one concatenated chosen+rejected policy forward
70% lineage-atomic token budget
information-per-token ranking
256-token maximum tail after first divergence
1024-token training sequence ceiling
no gradient checkpointing on the 12 GB target tier
no inline development evaluation
mandatory external frozen-base verifier unchanged
```

### Why this is a more sophisticated network

The adapter has more rank than the previous rank-16 configuration and uses rank-stabilized scaling. It explicitly covers both grouped-query attention projections and the SwiGLU feed-forward path rather than relying on an opaque `all-linear` selector. The base model remains frozen and exact, so the increased trainable capacity remains cheap relative to full fine-tuning.

With four rank-24 specialists, exact concatenation requires `max_fused_rank=96`. A smaller requested rank deliberately invokes the existing deterministic SVD compression gate and records reconstruction error.

### Why this is cheaper

The policy-only objective removes the two frozen-reference sequence arms from every gradient step. The external verifier still evaluates the trained adapter against the exact frozen base, so the safety and quality gate is not removed.

The token budget then selects whole repair lineages by:

```text
evidence_weight × log2(2 + divergent_information_tokens)
---------------------------------------------------------
                 model_forward_tokens
```

This prioritizes verified causal differences over repeated prompt and target tail tokens while preserving lineage atomicity. At a 70% token budget, the configured forward-token estimate is approximately:

```text
old: 100% data × policy and reference = 200% arm-token work
new: 70% data × policy only          =  70% arm-token work
estimated reduction                  =  65%
```

Actual wall-clock reduction depends on padding, backward cost, optimizer overhead, storage, and GPU utilization. Every real run records the selected and omitted pair IDs, realized token fraction, and estimated forward-token reduction in the training receipt.

## Truth boundary

This design and its tests prove only that the cheaper training method is executable and fail-closed. They do not prove that CUDA training occurred, that any tensor changed, that a fused model improved, that quantization retained quality, or that a model is publishable.
