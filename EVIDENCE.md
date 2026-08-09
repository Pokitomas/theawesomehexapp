# ARCHIE retained evidence

This file is the compact residue kept while removing stale implementation families. Historical code is not current architecture.

## Current source boundary

The observed current Aug-8 laboratory source lives outside this stale GitHub tree at:

`/mnt/c/Users/AwesomeKai/Documents/New project/archie-root-audit`

Observed active dependency chain:

`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`

Recorded source hashes:
- trainer: `4235f2fcbbfd1f1e490cae9a564c515ded9f9daa1c61e65a13244f9be33ff34e`
- core: `53714ea61d56aad72646c32d53163eee54ab402b108e9958962e702ed188f0dd`

Do not synthesize current typed-Delta source from retired repository implementations. This repository is not canonical model source until the exact live files are imported and hash-checked.

## Retired selective-SSM hybrid lane

Removed after scrape and cross-reference audit.

Preserved defect: its parallel affine scan used `cumprod(a).clamp_min(1e-20)` before `b / prefix`, which changes the recurrence after the true prefix falls below the clamp. For constant `a=0.1`, `b=1`, `s0=0`, 64 steps should approach about `1.111111`; the implementation produced about `45.1111`. The old contract checked finite execution but not equivalence with the defining sequential recurrence.

Its resume receipt also retained cumulative tokens while resetting elapsed runtime and nonfinite-step count, making resumed throughput/cleanliness accounting non-cumulative.

These defects were localized to the retired SSM path and are not evidence against current typed Delta.

## Retired causal-divergence / segmented / RSLoRA lanes

Removed after scrape. They were not in the current typed-Delta graph and did not contain an admitted current checkpoint.

Useful design residue:
- supervise verified repair after the first chosen/rejected divergence;
- disable TF32 in strict numerical/evaluation reference lanes;
- bind datasets, checkpoints, tokenizer, code revision, optimizer state, RNG state and receipts exactly across resume;
- exact LoRA fusion combines deltas, not averaged factors: concatenate rank blocks so `B* A* = sum_i w_i scale_i B_i A_i`;
- when source RSLoRA scaling is already absorbed into `B`, fused output must use unit ordinary-LoRA scaling or the delta is scaled twice;
- recursive retraining should be triggered by concrete evaluator failures, not invented failures.

One committed old CUDA contract was internally stale: a test expected baseline commit `8bb6fac2809afcc55f91f900bc6bf16f84dfb788`, while its request named `04001f6bf13277b27ac55f6d4d60ab1952da56a5`.

## Historical hosted CPU RSLoRA receipts

Real but noncanonical optimizer evidence is retained separately in `00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json`.

- `lite-0.6b`: Qwen3-0.6B FP32 CPU, rank 16 / alpha 32, 4,587,520 trainable parameters, 8 optimizer steps, 70.5417 s. Held-out accuracy 0.25 -> 0.25; mean margin -6.10213 -> -1.95556 (`+4.14657`). Adapter SHA-256 `7cc3ca6d62fbc6ae6e93272c518944731629eea1b52180138c09b01773016618`.
- `deep-0.6b`: same base/rank, 32 steps, 125.1884 s. Accuracy 0.25 -> 0.50; mean margin -6.10217 -> +4.33932 (`+10.44148`). Adapter SHA-256 `a4656284823296f872122a09d86e3bbb485fb5d20b6e641ef01a10ec99969a76`.
- `target-1.7b-fast`: pinned Qwen3-1.7B revision `8d4744f9e13072f4920c326350fa81eedb74eae9`, CPU BF16, rank 4 / alpha 8 on `q_proj,v_proj`, 802,816 trainable parameters, 1 optimizer step, 30.7232 s. Mean margin -9.34475 -> -9.05729 (`+0.287458`). Adapter SHA-256 `0523fdad350180e1aa5c365eaf8f852e3aa85febe012ef92e172ba11aa8b5a63`.

These receipts prove bounded CPU parameter updates and local held-out movement only. They do not establish CUDA/NF4 parity, fused-candidate gain, quantization retention, broad capability, reproduction, or admission.

## Retired training compiler / distillation package surface

Scraped before removal on 2026-08-08.

The remaining `ARCHIE_TRAINING.md`, `ARCHIE_DISTILL.md`, `scripts/archie-training-compile.mjs`, `foundry/archie-neural/archie-training-compiler.mjs` and `foundry/archie-distill/train.py` package surface had become severed: the compiler implementation and trainer entrypoint were absent while package scripts/docs still advertised them. The wrapper itself only loaded config, bound file hashes and delegated to the missing compiler. Its useful idea—atomic workspace creation plus exact source receipts—is already captured above and does not justify retaining a broken command surface.

## Retained transport/runtime spine

These similarly named files are not retired neural-model implementations and remain because they implement the current host/relay path or its direct dependencies:

- `scripts/archie-hybrid-hosted.mjs`
- `scripts/archie-hybrid-runner.mjs`
- `scripts/archie-enrolled-hybrid-runner.mjs`
- `scripts/archie-hybrid-queue.mjs`
- `scripts/archie-hybrid-protocol.mjs`
- `scripts/archied-hosted.mjs`
- `scripts/archied.mjs`
- `scripts/archie-workspace-core.mjs`
- `scripts/archie-workspace-portable.mjs`
- `scripts/archie-workspace-file-provider.mjs`
- their direct hosted/workspace/standalone dependencies

The runner currently imports `archie-standalone-journey.mjs`, workspace portable/core/file-provider, and the enrolled runner. Hosted runtime imports the hybrid queue, workspace bundle verifier/importer, and `archied-hosted.mjs`. `archied-hosted.mjs` in turn imports hosted backup/security, hybrid protocol, workspace core, and `archied.mjs`. Keep that dependency closure until the relay is replaced or proven unused.

## Numerical research wording

For quaternion / Heisenberg / HRT-adjacent work, retain the numerical question without overstating it: test near-linear dependence, singular values, condition numbers, cancellation and precision sensitivity with TF32 disabled in the strict lane and FP64/FP32 references where feasible. Numerical degeneracy is evidence of numerical degeneracy unless separately proved to imply something stronger.
