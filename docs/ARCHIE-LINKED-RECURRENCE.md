# Archie linked recurrence

This lane tests one narrow claim: whether the existing selective-SSM/local-attention model benefits from carrying its own state across contiguous source segments.

Implemented surfaces:

- checkpoint-compatible `RecurrentArchieHybridLM`;
- per-layer SSM recurrent state plus causal-convolution history;
- per-layer local-attention KV state with validity masks, local-window truncation and per-row positions;
- `model.step(input_ids, ssm_state, kv_cache, reset_mask)`;
- full-vs-incremental parity tests;
- document-boundary reset tests;
- state detach, transplant and channel-shuffle controls;
- linked-segment cross-entropy for truncated backpropagation.

The empirical gate remains unchanged. Correct carried state must beat reset state on fixed later segments, and transplanted/shuffled state must produce a correctly directed penalty without damaging ordinary fixed-domain evaluation. This code is mechanics, not evidence that the trained 114M checkpoint learned useful recurrence.
