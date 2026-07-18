# Engineering handoff

## Active work

Continue PR #535 on branch `agent/iphone-first-quantization-research`.

- PR: `https://github.com/Pokitomas/theawesomehexapp/pull/535`
- Base: `main` at `0bc98d8fd5ac5d1876713063af512954a8da188a`
- Exact implementation head before this handoff commit: `1d585bd3f960bc20fae58ddef013bd0f36fb5533`
- State: open, draft, mergeable
- Authority: execute normal architecture, implementation, tests, CI repair, issue/PR updates, and merge when evidence is green. Stop only for missing credentials, irreversible spending, legal acceptance, destructive external actions, or a genuinely unresolved product choice.

## Decision already made

Use Unsloth only as an external Qwen training/merge/export accelerator. Do not vendor it, make it Archie’s runtime, or treat it as the brain.

Keep Mamba and RWKV-8 as Generation One architecture experiments. The uploaded material included source/designs but no Archie-trained checkpoints and no admitted iPhone runtime. Do not replace the current Qwen student merely because architecture source exists.

Keep ArchiveBox, Crawl4AI, and Whisper outside the neural core as possible future archive, web-ingestion, and speech faculties. Kid Pix, PixelWater, hm, and voice-ai are not neural-core inputs.

## Implemented on PR #535

### Existing Qwen quantization lane

- `scripts/archie-student-quantize.mjs`
- `scripts/tests/archie-student-quantize.test.mjs`
- `npm run archie:student:quantize`
- receipt schema `archie-student-quantization-receipt/v1`
- canonical candidates: `Q4_K_M`, `Q5_K_M`, `Q6_K`; `Q8_0` diagnostic only
- complete checkpoint, tool, log, intermediate, output, and source-training receipt binding
- candidates remain unadmitted

The quantizer launcher is now cross-platform: JavaScript fixture/tools launch through the exact Node executable with `shell: false`, and both the script and launcher are hashed. This fixed the prior Windows `spawn UNKNOWN` failure.

### Uploaded-source binding

`product/archie-architecture-source-catalog.json` records exact inspected identities without vendoring the uploads:

- Unsloth archive SHA-256 `0a35ae612d3bca1d2fdb3b6709c6efcb6dc06bbc437153ea6e068370ac22c393`
- Mamba archive SHA-256 `5da2347d1dd8d975c4cd406461c41276229813fa2076e9779bd1961e44095bf1`
- RWKV-8 note SHA-256 `14ded853a5e5630751d2df1b98eb94dba3a167727f0fe70d8a217e486ccf139b`

The catalog also classifies the faculty and excluded archives. Catalog membership proves source identity only—not quality, safety, compatibility, training, or admission.

### Architecture × quantization campaign

- `scripts/archie-quant-architecture-campaign.mjs`
- `scripts/tests/archie-quant-architecture-campaign.test.mjs`
- `ARCHIE_ARCHITECTURE_EXPERIMENTS.md`
- `npm run archie:research:architectures`
- `npm run archie:research:architectures:evaluate -- --results <results.json>`
- `npm run test:archie:architecture`

The immutable 12-cell matrix contains:

1. Qwen3/GGUF controls: Q4_K_M, Q5_K_M, Q6_K, Q8_0.
2. Mamba-2: weight-only INT8 and INT4.
3. Mamba-3 MIMO: weight-only INT8 and INT4.
4. RWKV-8: matrix-state INT8, low-rank-state INT8, quantized-state INT6, sparse quantized-state INT6.

Only Qwen/GGUF cells currently expose a materialization command. Mamba and RWKV cells are explicitly `blocked-research-proposal`; no runtime, exporter, checkpoint, or kernel is invented.

The evaluator:

- continues after declared expected blockers;
- preserves exact failure-code and log-digest receipts;
- blocks selection on any unexpected failure;
- requires identical training budget, hidden split, grader, workload set, and A15 device floor;
- requires independent, reproduced, physical-A15 evidence for comparability;
- returns a Pareto frontier only;
- never auto-selects or promotes a model.

### iPhone and intelligence gates already on this PR

The branch also contains the native SwiftUI iPhone runtime, canonical A15/4 GB target, nonce-bound device-evidence path, independent measurement-authority registry, and six-arm intelligence campaign. Do not weaken those gates to make an architecture experiment pass.

## Validation state at handoff

At exact head `1d585bd3f960bc20fae58ddef013bd0f36fb5533`:

- `npm run test:archie:architecture` passed 7/7 before publication.
- Exact repository tree workflow passed.
- Windows install workflow passed after the launcher repair.
- Archie Generation One evidence workflow passed.
- Native iPhone workflow was still in progress when this handoff was written.
- Other reported workflows on the exact head were green or intentionally skipped.

Always re-read current workflow state before merge because this handoff commit creates a newer head.

## Missing empirical inputs

No actual architecture comparison can complete until the relevant inputs exist.

For Qwen/GGUF:

- merged Archie/Qwen Hugging Face checkpoint;
- exact `convert_hf_to_gguf.py`;
- exact `llama-quantize` executable;
- bound training receipt.

For Mamba/RWKV:

- an explicit parameter-matched architecture specification;
- trained checkpoint under the same token/curriculum budget;
- quantized export path;
- mobile runtime and kernels;
- hidden-split evaluation;
- second clean reproduction;
- physical A15/4 GB evidence through the canonical harness.

Expected absence of those inputs is not a reason to abort the rest of the campaign. Record the expected failure and continue. Unknown NaNs, digest drift, comparison mismatches, runtime crashes, invalid evidence, or safety regressions are not expected blockers; investigate and stop selection.

## Next engineer execution order

1. Inspect current PR #535 head and all current workflow runs.
2. Repair any failure caused by the architecture lane; do not dismiss it as expected unless its exact failure code is declared for that candidate.
3. Run `npm run test:archie:architecture`, `npm run test:archie:distill`, and `npm run verify:repository` on the exact final tree.
4. Generate and inspect `npm run archie:research:architectures`; verify 12 unique cells and source-catalog binding.
5. Keep PR truth-boundary text synchronized with actual evidence.
6. Merge only when required CI is green and no unresolved review blocker remains.
7. After merge, record exact feature head, merge SHA, workflow evidence, and remaining empirical blockers. Do not claim a model was produced or selected.

## Prior merged product baseline

PR #511 was previously merged to `main` as `4b2386606a8e43e7914fd0e837cec5f496cc9e49`. Preserve its independent opaque-program product architecture. Do not turn Archie, Maker, Founder, Foundry, and Expo into one generic AI dashboard while working on the neural backend.

## Truth boundary

This repository now has executable architecture-experiment and quantization infrastructure. It does not yet have uploaded model weights, a trained Mamba/RWKV candidate, an admitted mobile recurrent runtime, independent physical A15 evidence, or an empirically selected neural architecture.
