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

## Naming collision explicitly retained

`scripts/archie-hybrid-runner.mjs`, `scripts/archie-hybrid-queue.mjs`, `scripts/archie-enrolled-hybrid-runner.mjs`, `scripts/archie-hybrid-protocol.mjs`, and `scripts/archie-hybrid-hosted.mjs` were scraped before deletion consideration and are **not** the retired LM hybrid. They implement outbound runner / lease / fencing / event-chain / hosted transport mechanics and are retained pending the current Vercel transport repair audit.

## Current source boundary

Observed current canonical source lives outside this stale GitHub tree at:

`/mnt/c/Users/AwesomeKai/Documents/New project/archie-root-audit`

Active dependency chain recorded by the Aug-8 lab audit:

`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`

Recorded source hashes from the current lab observer:
- trainer: `4235f2fcbbfd1f1e490cae9a564c515ded9f9daa1c61e65a13244f9be33ff34e`
- core: `53714ea61d56aad72646c32d53163eee54ab402b108e9958962e702ed188f0dd`

No current typed-Delta source file is being synthesized from the stale July GitHub implementation. The repository should not be declared canonical until those exact live files are imported and hash-checked.
