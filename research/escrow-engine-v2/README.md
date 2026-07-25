# ESCROW Engine v2

This branch contains an executable proof-carrying scheduler for finite stochastic artifacts. The original toy construction remains a mechanism test, not a neural breakthrough.

## Engine contract

For every installed action, the artifact and reference kernels must both be declared members of one credal family. Runtime retains a point distribution and one scalar debt bound:

```text
artifact step:  z' <= dbar*z + width
reference step: z' <= delta(reference)*z
```

The engine executes real kernels, recomputes debt and cost transitions, arrests on mutation or malformed plans, and records exact/statistical authority in its ledger. Full credal trajectory sets are never propagated at runtime.

## Real Archie checkpoint result

The branch was tested against a real 114,215,040-parameter, 20-layer Archie checkpoint on 288 repository contexts drawn from code, documentation, JSON/data, and GitHub workflows.

The hard neural claim failed:

- early exits were too destructive;
- bfloat16 was slower than FP32 on the target CPU;
- exact-tail int8 produced tiny gains and prompt-level violations;
- the factor-level affine envelope did not imply a per-prompt output certificate.

The narrow surviving integration is a batch-8 statistical controller:

1. identify factor-admissible int8 positions;
2. execute dynamic int8;
3. apply a calibration-only conformal residual gate;
4. execute FP32 on rejected positions;
5. update debt using the operator actually returned.

Five file-disjoint folds covered all 288 contexts exactly once. At `tau=0.10` and requested conformal alpha `0.01`:

```text
unsafe accepted int8 outputs:   0 / 126
factor-envelope violations:     0
aggregate FP32 baseline:        68.7577 s
aggregate controller runtime:   66.6676 s
aggregate speedup:              1.0314x
fold speedup range:             0.907x–1.171x
```

This is real but weak. One fold slowed down, paired calibration/setup dominates a single run, and the statistical guarantee is neither worst-case nor time-uniform. **New science and robust total-cost superiority are not established.**

See `REAL_ARCHIE_VERDICT.md` and `real_archie_results.json` for the complete boundary.

## Run the standalone engine

```bash
cd research/escrow-engine-v2
python escrow_engine.py
pytest -q
```

## Hostile boundaries

- Diameter is not automatically artifact error; joint artifact/reference membership is mandatory.
- A singleton credal family can contain an exceptional row with width zero.
- Explicit credal trajectory propagation grows exponentially; the runtime uses a scalar envelope instead.
- Affine composition prices already-certified transitions; it does not establish interface composability.
- Neural readout error requires a separate certificate.
- The current real result is checkpoint-, workload-, hardware-, batching-, and exchangeability-dependent.
