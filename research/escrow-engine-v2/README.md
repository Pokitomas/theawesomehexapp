# ESCROW Engine v2

This branch contains the first executable cut of **Expiring Substitution with Certified Residual Operator Width**.

The previous bundle had a valid affine propagation theorem but no engine: its runtime returned an artifact label instead of executing a substitute. This cut replaces that shell with a proof-carrying stochastic-kernel scheduler.

## Engine contract

For each action, both the installed artifact kernel and the declared reference kernel must be exact members of one finite credal family. The certificate records family, artifact, and reference digests plus

```text
artifact step: z' <= dbar*z + width
reference step: z' <= delta(reference)*z
```

The runtime:

- executes actual point distributions through actual kernels;
- plans the cheapest safe artifact/reference sequence under `z <= tau`;
- recomputes every debt and cost transition at execution time;
- arrests on changed kernels, malformed plans, missing membership, or gate violation;
- emits an oracle ledger and optional exact-reference audit.

No full credal set is propagated at runtime. The retained state is one point distribution plus one scalar debt bound.

## Phase change

The included artifact has standalone safe horizon 1 at `tau=0.30`:

```text
artifact envelope: z' <= 0.6z + 0.2
```

The exact reference contracts debt:

```text
reference envelope: z' <= 0.2z
```

The periodic scheduler finds `A R A R ...`. Its invariant peak debt is `0.2272727273`, below the gate forever. Average execution cost is `0.525` reference-step equivalents, a `1.9047619x` speedup over reference-only execution. A 20-step plan uses 10 artifact and 10 reference steps and costs `10.5` instead of `20.0`.

This is the actual integration result: neither the expiring artifact nor the expensive reference gives indefinite cheap execution alone; their certified switched schedule does.

## Run

```bash
cd research/escrow-engine-v2
python escrow_engine.py
pytest -q
```

## Hostile boundaries

- Diameter is not automatically artifact error; joint artifact/reference membership is mandatory.
- A singleton credal family can contain an exceptional row with width zero.
- Explicit credal trajectory propagation doubles every step; the test reaches `2^14 = 16384` paths.
- Affine composition prices already-certified transitions; it does not establish interface composability.
- The neural deployment and literature novelty remain unsealed.

The complete sealed research bundle, including the long schizonote, theorem paper, claims ledger, manifest, and 21-test suite, is delivered separately as `ESCROW_ENGINE_V2_SEALED.zip`.
