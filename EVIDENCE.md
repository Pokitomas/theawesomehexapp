# ARCHIE retained evidence

This file is the compact residue retained while removing stale implementation sprawl.

## Retired selective-SSM hybrid lane

Retired 2026-08-08 after content and reference audit.

Removed lane:
- `foundry/archie-distill/archie_hybrid_core.py`
- `foundry/archie-distill/archie_hybrid_corpus.py`
- `foundry/archie-distill/train_archie_hybrid.py`
- `foundry/archie-distill/test_archie_hybrid_contract.py`
- `docs/archie-scratch-hybrid.md`
- `.github/workflows/archie-scratch-hybrid.yml`

Reason: this is the older from-scratch selective-SSM/local-attention line, not the current Aug-8 typed-Delta laboratory (`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`). Repository cross-reference search found `archie_hybrid_core` imported only by the retired trainer/corpus/contract set.

Critical preserved defect: `SelectiveStateSpace.forward` implemented the affine recurrence with

`prefix = cumprod(a).clamp_min(1e-20)` followed by `cumsum(b / prefix)`.

Clamping the cumulative product before division changes the recurrence once the true prefix falls below the clamp. For constant `a=0.1`, `b=1`, `s0=0`, 64 steps should approach about `1.111111`; the implementation produces about `45.1111`. This is an algorithmic error, not ordinary floating-point noise. The old contract test checked finite forward/backward behavior but did not compare the parallel scan to the defining sequential recurrence.

The old trainer also reset elapsed runtime and `skipped_nonfinite_steps` on resume while retaining cumulative `tokens_seen`, so resumed throughput/cleanliness receipts were not cumulative.

Do not infer these defects apply to the current typed-Delta path; the bad clamp/cumprod implementation was localized to this older hybrid SSM line.

## Retired verifier-anchored causal-divergence QLoRA lane

Scraped before removal on 2026-08-08.

Useful residue:
- The pair compiler bound a negative trajectory to an independently verified positive descendant only when request bytes matched, then supervised the verified repair and applied a frozen-reference preference loss only after the first divergent target token.
- The trainer explicitly disabled TF32 and required deterministic CUDA QLoRA. That strict-precision behavior is worth retaining as a court design principle, not as a current model dependency.
- The committed truth boundary states: method implemented, CUDA training by that change `false`, adapter artifact `false`, capability evaluation `false`, candidate promotion `false`.
- The Linux digital twin deliberately executed zero gradient and zero optimizer steps and could only prove fail-closed CPU refusal.
- The lane had an internal stale-contract contradiction: `test_cuda_causal_workflow_contract.py` expected request `baseline_commit = 8bb6fac2809afcc55f91f900bc6bf16f84dfb788`, while `.github/training/archie-cuda-request.json` contained `04001f6bf13277b27ac55f6d4d60ab1952da56a5`.

This lane is not in the Aug-8 typed-Delta forward graph and carried no admitted model artifact, so its executable scaffolding was retired rather than allowed to remain as apparent current machinery.

## Retired RSLoRA / segmented-tokenized distillation lane

Scraped before removal on 2026-08-08. Repository search found the information-budgeted receipt schema only in its implementation, not in a committed completed training receipt.

Useful residue retained as design knowledge:
- Causal-fork replay concentrated supervised compute after the first chosen/rejected divergence while preserving bounded prompt and shared-prefix witnesses.
- Shards preserved repair-lineage atomicity and balanced estimated attention area instead of raw pair count.
- Frozen-reference chosen/rejected log probabilities could be cached when bound to exact checkpoint, tokenizer, pair bytes and replay policy.
- Exact LoRA fusion must combine deltas, not average factors. For source adapters, concatenate A rank blocks and concatenate weighted/scaled B rank blocks so `B* A* = sum_i w_i scale_i B_i A_i`.
- When RSLoRA source scaling has already been absorbed into B, the fused adapter must use unit ordinary-LoRA scaling (`use_rslora=false`, `lora_alpha=fused_rank`) or it scales the delta twice.
- Elastic resume receipts bound complete model/adapter, optimizer, scheduler, RNG, scaler and Trainer state plus exact input/cache/software identities. This is a useful checkpoint-integrity pattern.
- Recursive rounds were gated on concrete evaluator failures rather than synthetic failure invention.

Why removed:
- The family is not in the current typed-Delta model path.
- Its current workflows depended on the retired causal-divergence trainer/profile and were therefore already severed as a live execution graph.
- Every lane kept `promotion: not-admitted`; no committed information-budgeted completed receipt was found by repository search.
- The included Linux CPU corpus is a small hand-authored contract corpus about the old workflow itself, not current model data.

## Naming collisions explicitly retained

`scripts/archie-hybrid-runner.mjs`, `scripts/archie-hybrid-queue.mjs`, `scripts/archie-enrolled-hybrid-runner.mjs`, `scripts/archie-hybrid-protocol.mjs`, and `scripts/archie-hybrid-hosted.mjs` were scraped before deletion consideration and are **not** the retired LM hybrid. They implement outbound runner / lease / fencing / event-chain / hosted transport mechanics and are retained pending the current Vercel transport repair audit.

Supporting transport objects already scraped and provisionally retained:
- `scripts/archie-workspace-core.mjs`: digest-bound append-only workspace event state.
- `scripts/archie-workspace-portable.mjs`: verifies/imports/exports exact event and artifact bundles.
- `scripts/archie-workspace-file-provider.mjs`: bounded file provider wrapper.

`scripts/archie-standalone-journey.mjs` was also scraped. It is a deterministic synthetic product fixture, not current model logic; it is not automatically protected merely because an old runner imports it.

`.github/workflows/archie-linux-distilling-chamber.yml` was scraped after a name collision. It is a JS chamber verifier and is not the RSLoRA Linux CPU trainer workflow, so it was left for its own later audit.

## Current source boundary

Observed current canonical source lives outside this stale GitHub tree at:

`/mnt/c/Users/AwesomeKai/Documents/New project/archie-root-audit`

Active dependency chain recorded by the Aug-8 lab audit:

`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`

Recorded source hashes from the current lab observer:
- trainer: `4235f2fcbbfd1f1e490cae9a564c515ded9f9daa1c61e65a13244f9be33ff34e`
- core: `53714ea61d56aad72646c32d53163eee54ab402b108e9958962e702ed188f0dd`

No current typed-Delta source file is being synthesized from the stale July GitHub implementation. The repository should not be declared canonical until those exact live files are imported and hash-checked.
