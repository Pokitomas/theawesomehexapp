# Neural register-transfer isolation plan

This document preregisters the follow-up to PR #692 before its new frozen-pack results exist.

## Run D — exact corpus-mix isolation

Repeat run C's seed, architecture, optimization, synthetic scale, governed real-language corpus, and 15× real-row repetition, but set post-hoc fine-tuning epochs to zero. This changes one variable relative to run C and directly measures the real-dominant corpus mix without shared-trunk fine-tuning.

**Execution boundary discovered before training:** run C's exact 925-row governed corpus, all three legacy JSONL suites, and the audit archive bytes are not retained in the repository or prior Actions artifacts. Run D is therefore blocked rather than reconstructed from guessed data.

## Run F — committed-data authored mix

As a separate experiment, generate a deterministic route corpus solely from committed `protocol-corpus.mjs` prompts, weight it to dominate the mixed procedural training set, and train the same d128 transformer without a post-hoc fine-tune. Evaluate only the committed blind-429 pack. This run is not described as run D or as causal isolation of run C.

## Run G — protected adaptation

Start from run F's fixed checkpoint. Train only `Hroute` and `Hbroute`; all shared-trunk parameters and all auxiliary heads must retain an identical SHA-256 digest before and after adaptation. Use a fixed 1:1 authored/synthetic-replay mixture, a proximal penalty to the source route head, and generated development accuracy/NLL for checkpoint selection. Evaluate the blind pack only after selection.

## Promotion rule

Neither run is admitted because the mandatory legacy-retention suites are unavailable. Production remains the existing admitted register-aware router regardless of blind-pack performance.
