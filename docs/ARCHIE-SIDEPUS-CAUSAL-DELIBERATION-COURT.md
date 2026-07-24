# Archie Sidepus causal deliberation court

## Decision

The previous integrated organism and pursuit forward paths pooled the complete current window into one deliberation vector and broadcast that vector back to every token position. That made ordinary next-token losses, retention scores, and per-thought losses unsuitable as causal evidence.

This successor does not reinterpret those measurements. It replaces the global path with one token-local thought trajectory per causal backbone position and requires adversarial suffix invariance before any smoke or full GPU launch.

## Machine boundary

For token position `t`, deliberation may consume only:

- the causal language-shell representation at `t`;
- the world-state read available before the current event-chunk write;
- the token-local plastic-memory read.

Batch and token positions may be flattened for parallel execution across thought depth, but no reduction, attention, pooling, or state transfer may mix sequence positions inside deliberation.

The final action/value/stop heads may use the last causal thought plus the completed world state. They are not used to score earlier token predictions.

## Structural court

`test_sidepus_causality.py` appends an adversarial suffix and requires unchanged prefix:

- integrated logits;
- token-local thought vectors;
- halt probabilities;
- pursuit logits;
- every forced-depth thought state;
- halt weights;
- reset and genuinely carried-state paths.

Both campaign launchers run this court before corpus work or CUDA training.

## Measurement correction

The halt warmup target and loss-plus-compute oracle are separate quantities.

The training history now records:

- actual oracle deliberation depth;
- supervised warmup depth;
- aggregate and token-level marginal gain;
- fraction of target tokens whose oracle depth exceeds one;
- fraction assigned extra computation by the halt policy;
- halt/oracle agreement;
- halt regret.

The new improvement-margin and halt-warmup controls are bound into the immutable training contract. The default state, cache, and export roots use a new `v3-causal` lineage, so no old pursuit checkpoint can be silently resumed under the changed semantics.

## Claim boundary

Passing the structural court proves only prefix causality for the tested mechanics. It does not prove useful state, useful extra computation, active-pursuit superiority, held-out transfer, language retention, or admission.

The previous smoke remains historical engineering evidence only. A fresh isolated causal smoke is required. A full campaign remains forbidden until a disjoint evaluation plan measures positive state utility and useful extra depth without training-window overlap.
