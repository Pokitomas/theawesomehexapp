# Verifier-Anchored Causal-Divergence QLoRA

This training lane is an executable neural objective. It is not a statistical router and it does not promote a checkpoint by declaration.

## Method

1. `compile_causal_pairs.py` reads admitted `archie-trajectory-batch/v1` evidence.
2. It pairs an admitted negative trajectory with an admitted positive descendant whose `parent_trajectory_digest` points to the failure and whose request bytes are identical.
3. `train_causal_divergence.py` preserves the chosen/rejected shared target prefix.
4. It applies supervised fine-tuning to the verified repair.
5. It applies a frozen-base-reference preference margin only at and after the first divergent target token.
6. It weights the pair by bound verification evidence and updates only QLoRA adapter parameters on a local CUDA-loaded NF4 checkpoint.

The intended effect is to teach the model the causal decision that separated a failed trajectory from its independently verified repair, rather than teaching a generic refusal string or penalizing a valid shared prefix.

## Compile pairs

```bash
python foundry/archie-distill/compile_causal_pairs.py \
  --batch /path/to/trajectory-batch.json \
  --output /path/to/causal-pairs \
  --seed 3407 \
  --holdout-rate 0.2
```

The output contains:

- `causal-preference.train.jsonl`
- `causal-preference.development.jsonl`
- `causal-preference-receipt.json`

## Train

```bash
python foundry/archie-distill/train_causal_divergence.py \
  --profile /path/to/profile.json \
  --workspace /path/to/compiled-workspace \
  --preference-data /path/to/causal-pairs/causal-preference.train.jsonl \
  --preference-eval-data /path/to/causal-pairs/causal-preference.development.jsonl \
  --preference-receipt /path/to/causal-pairs/causal-preference-receipt.json \
  --output /path/to/training-output
```

The trainer refuses CPU fallback, network model loading, non-4-bit loading, and non-LoRA trainable parameters.

## Truth boundary

A successful run proves that real CUDA QLoRA gradients executed under this objective and produced a bound adapter artifact and receipt. It does not prove capability improvement, safety, authority compliance, clean reproducibility, device fitness, or production admission. Those claims require the existing hidden evaluation, independent authority, reproduction, and physical-device gates.

The method is repository-new experimental work. This repository does not claim global first publication or prior-art priority without a formal literature and patent review.
