# Archie cognitive-controller research

This directory contains **shadow-only** local controller research. It does not replace the admitted production router, and it does not modify deterministic permission, execution, rollback, or admission controls.

## Current decision

The strongest legitimate checkpoint remains the frozen v9 runtime at **294/310 (94.84%)** on the protected post-freeze pack.

The later factorized v2 experiment implemented a byte-GRU, character/word discriminative signals, clause-level execution, typed references, factorized authority, log-space fusion, calibration reporting, and quantized checkpoint storage. It was trained and evaluated locally without Moonshot or any external teacher.

Its final protected result was **239/310 (77.10%)**. Relative to v9, it repaired **1** case and regressed **56**. Quantized storage reproduced **239/310** exactly. The new untouched blind-v2 pack scored **121/287 (42.16%)**. Promotion therefore remains `not-admitted`.

The earlier apparent `310/310` v12 result is not legitimate admission evidence. Its runtime added evaluation-specific route and policy regexes after the protected phrases had been inspected. It is retained only as negative evidence.

## Research paths

- `factorized-v2/` — completed legitimate factorized experiment, frozen blind pack, executable source, and exact receipts.
- `artifacts/cognitive-router-v1/` — falsified v10/v12 recurrent candidate and leakage-era artifacts, retained only for audit history.
- `../archie-protocol/typed_recurrent_controller.py` — earlier typed recurrent architecture investigation.

## Reproduce factorized v2

The v2 route backbone requires the pinned v9 research checkpoint `router_bundle.joblib` with SHA-256:

```text
06d33ca857dc6ab2c678a6bfe2ec65b8c3d223052d0109280bbc2301a00c7414
```

From `factorized-v2/`:

```bash
python build_blind_v2.py
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 \
  python train_factorized_controller_v2.py
PYTHONPATH=. python test_structural_isolation.py
python quantize_checkpoint.py
```

See `factorized-v2/artifacts/final-report.json` and `docs/archie-factorized-controller-v2.md` for exact results, hashes, calibration, category matrices, regressions, isolation failures, and environmental limitations.
