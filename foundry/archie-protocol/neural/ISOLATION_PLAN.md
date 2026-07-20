# Neural register-transfer isolation plan

This document preregisters the follow-up to PR #692 before its frozen-suite results exist.

## Run D — corpus mix isolation

Repeat run C's seed, architecture, optimization, synthetic scale, governed real-language corpus, and 15× real-row repetition, but set post-hoc fine-tuning epochs to zero. This changes one variable relative to run C and directly measures the real-dominant corpus mix without shared-trunk fine-tuning.

## Run E — protected adaptation

Start from run D's fixed checkpoint. Train only `Hroute` and `Hbroute`; all shared-trunk parameters and all auxiliary heads must retain an identical SHA-256 digest before and after adaptation. Use a fixed 1:1 governed-real/synthetic-replay mixture, a proximal penalty to the source route head, and generated development accuracy/NLL for checkpoint selection. Evaluate frozen suites only after selection.

## Promotion rule

Neither run is admitted unless it clears every declared legacy-retention and blind evaluation gate. Production remains the existing admitted register-aware router otherwise.
