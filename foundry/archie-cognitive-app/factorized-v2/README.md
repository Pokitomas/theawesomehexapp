# Factorized controller v2

Shadow-only research implementation. **Promotion: `not-admitted`.** The frozen v9 checkpoint remains selected.

## Completed result

- protected post-freeze: `239/310` (`77.10%`), versus v9 `294/310`;
- relative to v9: `1` repair, `56` regressions, `15` unchanged failures;
- untouched blind-v2: `121/287` (`42.16%`);
- int8 storage replay: exact `239/310` parity;
- unsafe authority: `24/24`;
- failed slices include benign authority, present references, negation, ordered compounds, abstention, and resource use.

## Files

- `factorized_controller.py` — common byte-GRU, discriminative, typed-context, and clause runtime.
- `factorized_controller_v2.py` — conservative v9-backed fusion and factorized authority policy.
- `train_factorized_controller_v2.py` — exact executed training source embedded losslessly; decoded source SHA-256 is recorded in the header.
- `evaluate_factorized_v2.py` — evaluator that reproduces the 239/310 protected receipt.
- `build_blind_v2.py` — blind-v2 generator; the exact frozen payload is also committed in compressed form.
- `materialize_blind_v2.py` — restores and verifies the 287-row frozen payload.
- `test_structural_isolation.py` — payload invariance and trusted-metadata counterfactuals.
- `quantize_checkpoint.py` — symmetric per-tensor int8 storage conversion.
- `artifacts/` — compact receipts with exact identities and negative evidence.

## External checkpoint

The runtime requires the pre-existing v9 research bundle:

```text
router_bundle.joblib
SHA-256 06d33ca857dc6ab2c678a6bfe2ec65b8c3d223052d0109280bbc2301a00c7414
```

The new shadow binaries are identified but not duplicated through the connected text-only GitHub publication path. They are included in the downloadable local delivery archive.

## Reproduce

```bash
python materialize_blind_v2.py
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 \
  python train_factorized_controller_v2.py \
  --out /mnt/data/archie_app \
  --postfreeze /mnt/data/postfreeze-v9.json \
  --v9-model /mnt/data/router_bundle.joblib

PYTHONPATH=. python evaluate_factorized_v2.py /mnt/data/postfreeze-v9.json \
  --out artifacts/reproduced-postfreeze.json \
  --bundle artifacts/factorized-controller-v2.joblib \
  --gru artifacts/byte-gru-v2.pt \
  --v9 /mnt/data/router_bundle.joblib
```

The evaluator was replayed after publication preparation and reproduced 239/310 with identical error IDs and decision-source counts.
