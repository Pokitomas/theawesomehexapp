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

### Hosted CPU RSLoRA runs preserved separately

`00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json` records real optimizer updates on a bounded repository-governance rehearsal corpus. These are **not** canonical information-budgeted/CUDA/NF4 evidence and were explicitly `promotion: not-admitted`, but they are real experimental results and must not be erased conceptually with the retired workflow code.

Observed runs:
- `lite-0.6b`: Qwen3-0.6B, CPU FP32, RSLoRA rank 16 / alpha 32, 4,587,520 trainable parameters, 8 optimizer steps, 70.5417 s, peak RSS 5,028,356,096 B. Four held-out pairs: accuracy 0.25 -> 0.25, mean pair margin -6.10213 -> -1.95556, delta +4.14657. Adapter model SHA-256 `7cc3ca6d62fbc6ae6e93272c518944731629eea1b52180138c09b01773016618`; receipt digest `92ac4a593ac26f36376182e7ec14418c28270f62563abb4f357a6b15f9531c99`.
- `deep-0.6b`: Qwen3-0.6B, CPU FP32, same rank/alpha and trainable count, 32 optimizer steps, 125.1884 s, peak RSS 5,059,674,112 B. Four held-out pairs: accuracy 0.25 -> 0.50, delta +0.25; mean pair margin -6.10217 -> +4.33932, delta +10.44148. Adapter model SHA-256 `a4656284823296f872122a09d86e3bbb485fb5d20b6e641ef01a10ec99969a76`; receipt digest `177f1f98ae0cb079b90b77d861a25b12e5e60ce3178ea22aa79bb889c24b46a9`.
- `target-1.7b-fast`: exact pinned Qwen3-1.7B revision `8d4744f9e13072f4920c326350fa81eedb74eae9`, CPU BF16, RSLoRA rank 4 / alpha 8 on `q_proj,v_proj`, 802,816 trainable parameters, 1 optimizer step, 30.7232 s, peak RSS 4,939,075,584 B. One held-out pair: accuracy 0 -> 0, mean pair margin -9.34475 -> -9.05729, delta +0.287458. Nonzero adapter tensors: 112, including 56 nonzero LoRA-B tensors. Adapter model SHA-256 `0523fdad350180e1aa5c365eaf8f852e3aa85febe012ef92e172ba11aa8b5a63`; receipt digest `6893194b2343281bed96bfbb995bbb179fbae035e1e58b48d3f96f61224ccda8`.

The evidence file's own boundary is correct: these prove bounded hosted-CPU RSLoRA updates and held-out movement, including one exact-checkpoint 1.7B step; they do not establish CUDA/NF4 parity, canonical rank-32 training, fused-candidate gain, quantization retention, broad capability, independent reproduction, or admission.

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
