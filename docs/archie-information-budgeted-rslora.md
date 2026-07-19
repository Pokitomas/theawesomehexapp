# Archie information-budgeted RSLoRA

## The Occam hypothesis

The current causal-divergence lane is correct but pays uniformly for tokens that do not carry equal learning value. Every pair contains three regions:

```text
prompt + context
shared chosen/rejected target prefix
first divergent token and its consequences
```

The first two regions are necessary context, but the verified repair signal lives at and after the causal fork. This lane therefore asks one narrow empirical question:

> Can Archie preserve or improve full-sequence held-out quality while spending compute and adapter rank according to post-divergence information rather than raw sequence length?

RSLoRA is not claimed as new science. It is the stabilizer that makes rank 32 practical. The repository experiment is the smallest combination that isolates the hypothesis:

```text
verified failed→repair pairs
  → causal-fork replay windows
  → lineage-atomic attention-area balancing
  → one frozen-reference scalar cache
  → stacked chosen/rejected forwards
  → two rank-32 RSLoRA specialists
  → exact scale-aware delta fusion to rank 64
  → unchanged full-sequence held-out gate
```

## Why this should be cheaper

The established lane uses four rank-16 specialists. Each specialist loads the same 1.7B base, evaluates the same global held-out split, and trains on full prompt-plus-target sequences. The new default uses two rank-32 specialists. The exact fused rank ceiling remains 64, but repeated model-load and per-specialist held-out work is cut from four copies to two.

Within each pair, training retains:

- the head of the system prompt;
- the most recent prompt/context suffix;
- a tail of the shared target prefix;
- the earliest post-divergence continuation, where the verified repair signal begins.

Only post-divergence tokens receive SFT and preference labels. Shards are balanced using the sum of squared replayed sequence lengths, a simple proxy for attention work, rather than raw token count.

The frozen base reference is evaluated once per training pair and stored as two scalar sequence log probabilities. Subsequent epochs use one stacked policy call for both chosen and rejected arms instead of repeating live frozen-reference forwards. With two epochs, the reference work is amortized rather than doubled.

## RSLoRA and fallback

The preferred adapter is:

```text
rank: 32
alpha: 16
scale: alpha / sqrt(rank)
```

The trainer checks the installed PEFT `LoraConfig` signature. When `use_rslora` is supported, it is enabled and recorded. When it is not supported, the run falls back to ordinary LoRA and records the exact reason. A fallback is evidence, not a silent success.

## Scale-aware fusion correction

Each source adapter's effective scale is absorbed into its B factor before exact rank concatenation:

```text
A* = concat(Aᵢ)
B* = concat(wᵢ · scaleᵢ · Bᵢ)
B* A* = Σ wᵢ · scaleᵢ · Bᵢ Aᵢ
```

Once those scales are absorbed, the fused adapter must use unit scaling. The information-budgeted fuser emits ordinary LoRA with:

```text
use_rslora: false
lora_alpha: fused_rank
r: fused_rank
```

This matters because retaining `use_rslora: true` would multiply the already-scaled fused delta by `sqrt(fused_rank)` a second time.

## Manual contract verification

```bash
python -m py_compile \
  foundry/archie-distill/information_budgeted_rslora.py \
  foundry/archie-distill/fuse_information_budgeted_adapters.py \
  foundry/archie-distill/test_information_budgeted_rslora.py

python foundry/archie-distill/test_information_budgeted_rslora.py
```

The dependency-light tests prove:

- causal-fork replay retains divergence supervision;
- replay reduces estimated attention area on long pairs;
- repair lineages remain atomic during shard balancing;
- cached and live frozen-reference scalar losses are numerically equivalent;
- gradients still flow through both policy arms;
- RSLoRA fallback and non-promotion boundaries are explicit.

## Dispatch

After the runner variables used by the segmented distillation lane are configured:

```bash
gh workflow run archie-information-budgeted-rslora.yml \
  --ref agent/archie-information-budgeted-rslora \
  -f request_id="archie-ib-rslora-$(date -u +%Y%m%dT%H%M%SZ)" \
  -f round=0 \
  -f shards=2 \
  -f max_fused_rank=64
```

The workflow performs CPU pair compilation and information balancing, then each CUDA worker builds a frozen-reference cache, trains one specialist, proves changed tensors, and runs the existing full-sequence held-out comparison. Only verified non-regressive specialists enter exact fusion. The fused-adapter evaluator remains the final pre-quantization gate.

## What would count as frontier progress

The code is not itself a global ML breakthrough. A meaningful result would require an empirical Pareto improvement against the established four-shard lane on the exact same source bundle:

```text
strictly lower measured GPU-seconds or processed attention area
AND
no held-out pair regression
AND
strict gain in accuracy, margin, or chosen-target likelihood
```

A stronger result would reproduce across multiple admitted trajectory batches and retain the gain after GGUF quantization. Until then, this is a falsifiable repository experiment, not a capability claim.

## Truth boundary

```text
CPU segmentation is not training.
A reference cache contains frozen-base scores, not learned weights.
CUDA receipts prove bounded local gradient runs only.
Changed tensors do not prove quality.
RSLoRA does not prove frontier novelty.
Fusion does not admit a model.
Full-sequence evaluation, quantization retention, independent reproduction, and human admission remain required.
```
