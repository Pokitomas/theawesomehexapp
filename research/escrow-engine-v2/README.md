# ESCROW Engine v2

This branch contains an executable proof-carrying scheduler for finite stochastic artifacts. The original toy construction remains a mechanism test, not a neural breakthrough.

## Engine contract

For every installed action, the artifact and reference kernels must both be declared members of one credal family. Runtime retains a point distribution and one scalar debt bound:

```text
artifact step:  z' <= dbar*z + width
reference step: z' <= delta(reference)*z
```

The engine executes real kernels, recomputes debt and cost transitions, arrests on mutation or malformed plans, and records exact/statistical authority in its ledger. Full credal trajectory sets are never propagated at runtime.

## Real Archie checkpoint result: quantized microbatch cut

The first real cut tested a 114,215,040-parameter, 20-layer Archie checkpoint on 288 repository contexts drawn from code, documentation, JSON/data, and GitHub workflows.

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
fold speedup range:             0.907x-1.171x
```

This is real but weak. One fold slowed down, paired calibration/setup dominates a single run, and the statistical guarantee is neither worst-case nor time-uniform. See `REAL_ARCHIE_VERDICT.md` and `real_archie_results.json`.

## Integrated persistent-state audit

A second, stricter experiment executed the integrated 123,265,923-parameter Sidepus pursuit checkpoint while carrying its 12-slot world state and rank-16 plastic memory between 32-byte chunks. The custom 20-layer reference path matched the shipped model exactly.

Raw early exits failed economically. A 16-layer executor plus a 165,760-parameter residual MLP improved mean next-token TV from 0.441 to 0.187 at measured cost ratio 0.736, but maximum TV remained 0.890.

The first finite factor then produced an apparent 26.4% certified saving by reporting zero artifact/reference debt. Actual artifact execution still had:

```text
mean next-token TV:                 0.194
maximum next-token TV:              0.890
final persistent-state relative L2: 0.111
```

The factor had erased the protected observable. A sweep from one to 32 output-derived states found no factor with both full transition support and a useful decoder residual.

The repaired runtime obligation is therefore:

```text
observable error <= artifact decoder residual
                  + factor debt
                  + reference decoder residual
```

`observable_gate.py` implements this fail-closed lift and rejects unsupported factor rows. `PERSISTENT_STATE_AUDIT.md` records the complete negative result.

**New science and robust total-cost superiority are not established.** The strongest surviving claim is that transition-debt and observable-decoder certificates are jointly necessary; either alone can be vacuous.

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
- Factor debt does not protect a neural readout without a common decoder certificate.
- Pseudocount smoothing does not establish support for an unobserved action-state row.
- Current real results are checkpoint-, workload-, hardware-, batching-, and statistical-assumption-dependent.
