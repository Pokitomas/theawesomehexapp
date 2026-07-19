# Canonical Archie architecture

## Identity

The current Archie model candidate is not the browser UI, the Maker runtime, the statistical specialist router, or the collection of older distillation experiments. It is the following trainable object:

```text
Qwen3-1.7B
+ verified failed→repair causal pairs
+ information-budgeted replay around the first divergence
+ two rank-32 RSLoRA specialists
+ exact scale-aware fusion to rank 64
+ full-sequence frozen-base evaluation
```

The rest of the repository exists to produce data for this object, let it act, verify its effects, preserve evidence, and decide whether it deserves admission.

## Why verified repairs are the training signal

A failed trajectory and its verified repaired descendant often share most of their context and even part of their proposed target. Penalizing the entire failed output wastes signal and can punish valid shared reasoning.

Archie instead locates the first token where the failed and repaired continuations diverge. Context before that fork is retained only as needed to understand the decision. Supervision begins at the fork and continues into the consequences.

```text
same request
same valid context
same valid target prefix
          ↓
first causal fork
  rejected continuation → evidenced failure
  chosen continuation   → independently verified repair
```

This asks the model to learn the decision that mattered, not merely imitate a complete replacement answer.

## Information-budgeted replay

Long sequences do not carry equal learning value. The canonical replay window keeps:

- the system-prompt head;
- the most recent prompt and environment context;
- a bounded tail of the shared target prefix;
- the earliest post-divergence continuation.

Only post-divergence tokens receive repair SFT and preference labels. Whole repair lineages remain atomic during sharding. Shards are balanced using the sum of squared replayed sequence lengths as a deterministic proxy for attention work.

The default window is:

```text
maximum sequence:             896 tokens
recent prompt/context:        384 tokens
system-prompt head:            32 tokens
shared target-prefix tail:     96 tokens
post-divergence continuation: 384 tokens
```

## Frozen-reference cache

The frozen base is evaluated once for each chosen and rejected arm. The resulting sequence log probabilities are bound to:

- base checkpoint identity;
- tokenizer identity;
- causal-pair digest;
- replay policy;
- code and profile identity.

Training epochs then use the cached reference scalars and one stacked policy-model invocation for the chosen and rejected arms. This removes repeated frozen-base forwards while preserving the reference-anchored loss.

## Specialist design

The canonical lane uses two specialists rather than four:

```text
adapter type: RSLoRA
rank: 32
alpha: 16
scale: alpha / sqrt(rank)
target modules: all linear projections
specialists: 2
```

Two rank-32 specialists retain the same exact rank-64 fusion ceiling as four rank-16 specialists while cutting repeated model loading and specialist-level held-out evaluation in half.

When the installed PEFT version does not support `use_rslora`, the trainer may fall back to ordinary LoRA only if the receipt records that fallback and its reason. Silent substitution is failure.

## Exact fusion

LoRA factors cannot be naively averaged. Each source adapter represents a scaled delta:

```text
ΔWᵢ = scaleᵢ · BᵢAᵢ
```

The canonical fuser absorbs the specialist weight and source scale into the B factor, then concatenates ranks:

```text
A* = concat(Aᵢ)
B* = concat(weightᵢ · scaleᵢ · Bᵢ)
B*A* = Σ weightᵢ · scaleᵢ · BᵢAᵢ
```

Because the source scales have already been absorbed, the fused adapter is emitted with unit ordinary-LoRA scaling:

```text
use_rslora: false
r: fused_rank
lora_alpha: fused_rank
```

Keeping RSLoRA scaling on the fused adapter would scale the delta a second time and is therefore rejected.

## Evaluation and admission

The model is evaluated at four distinct boundaries:

1. **Specialist tensor proof** — real optimizer steps changed adapter tensors.
2. **Specialist quality gate** — each adapter is compared against the frozen base on full held-out sequences.
3. **Fused quality gate** — the exact fused candidate must remain non-regressive and show a strict gain where required.
4. **Quantized retention and reproduction** — the deployable form must retain case-level behavior and reproduce independently.

No boundary may be replaced by workflow success, prose, or a checksum alone.

## System around the model

```text
Founder: captures one unfinished human intention
Archie: owns the objective, model reasoning, uncertainty, memory, and coordination
Maker: executes permissioned effects and verifies reality changed
Foundry: trains, evaluates, compares, reproduces, admits, or rejects models
```

The product system is intentionally larger than the neural adapter. The adapter is still the canonical learned model object.

## Canonical source graph

```text
maker/evaluations/archie-information-budgeted-rslora.json
        ↓
foundry/archie-distill/compile_causal_pairs.py
        ↓
foundry/archie-distill/information_budgeted_rslora.py
        ├─ segment
        ├─ cache-reference
        └─ train
        ↓
foundry/archie-distill/verify_segment_adapter.py
        ↓
foundry/archie-distill/fuse_information_budgeted_adapters.py
        ↓
foundry/archie-distill/evaluate_fused_adapter.py
        ↓
quantization, independent reproduction, benchmark suite, admission
```

The orchestration source is `.github/workflows/archie-information-budgeted-rslora.yml`.

## Current truth

The architecture is executable and contract-tested. The repository does not yet contain the complete receipt chain required to call the resulting candidate an improved or admitted Archie model.