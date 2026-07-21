# Neural register-transfer isolation plan

This document preregisters the follow-up to PR #692 before its exact frozen-suite results exist.

## Evidence boundary

The first attempt correctly stopped because run C's 925-row governed corpus and legacy suites were absent. A separate provenance repair has now committed `data/route-train-v6.json`, all three frozen legacy suites, and the preserved pre-fine-tune checkpoint `runs/npt-E-frozen-backbone-seed424243-pre-finetune.npz`. Their row counts and content digests must be verified before evaluation.

## Run D — exact corpus-mix isolation

Evaluate the preserved run-C checkpoint immediately before its shared-trunk fine-tune. This changes no weights and cleanly measures the real-dominant corpus mix without the damaging fine-tune phase.

## Run E — protected route-head adaptation

Start from D. Train only `Hroute` and `Hbroute`; all shared-trunk parameters and auxiliary heads must retain identical before/after SHA-256 digests. Use a fixed 1:1 governed-real/synthetic-replay mixture, proximal anchoring, and generated-development accuracy/NLL for checkpoint selection. Frozen suites are evaluated only after selection.

## Separate committed-data evidence

Runs F/G used only the repository-authored `protocol-corpus.mjs` prompts. F improved blind full accuracy from 54.3% to 55.5%; G selected epoch 0 and left F unchanged. They are preserved as a separate reproducible result, not as a substitute for D/E.

## Promotion rule

A replacement must retain every capability of the admitted register-aware projection, including perfect 498/60/48 legacy routing. Anything below those gates remains `not-admitted`; production stays unchanged.
