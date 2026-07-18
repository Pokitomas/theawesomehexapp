# Archie full-version gate

This gate is the repository-level receipt for the current Archie product surface. It does not claim that the model has been trained, admitted, or measured on a physical device.

## What it proves

The gate requires the repository to keep the executable local, hosted, hybrid, compatibility, portable-workspace, and distillation contract surfaces present at the same time.

The GitHub Actions workflow runs:

```bash
npm run test:archie:workspace
npm run test:archie:distill
npm run test:archie:repository-completion
node scripts/archie-full-version-gate.mjs
```

The generated `archie-full-version-gate.json` receipt records exact file identities and the package scripts that define the current full-version boundary.

## Training boundary

`foundry/archie-distill/train.py` remains the only real QLoRA training entrypoint. It is CUDA-only, offline, pinned to a local checkpoint, and refuses slow CPU fallback. A GitHub-hosted CPU runner may test the distillation contracts, but it must not emit a trained-candidate promotion receipt.

## Promotion boundary

A model cannot be represented as admitted until the student admission gate binds:

- a completed training receipt;
- an independent hidden evaluation;
- an authority report;
- a clean second-environment reproduction;
- sustained resource measurements;
- the exact founder intelligence target.

Missing evidence is a blocker, not a zero-score pass.
