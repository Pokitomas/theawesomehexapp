# ESCROW Engine v2

**Expiring Substitution with Certified Residual Operator Width** is now an engine, not a selector.

It executes explicit finite stochastic kernels, verifies that the installed artifact and the declared reference are members of the same credal family, synthesizes a least-cost safe schedule, runs that schedule, recomputes every debt transition at runtime, and arrests on any certificate, kernel, plan, cost, or jurisdiction mismatch.

The central runtime invariant is

\[
z_{t+1}\le \bar\delta_a z_t+w_a
\]

for an artifact step and

\[
z_{t+1}\le \delta(R_a)z_t
\]

for an exact reference step. Here \(z_t\) bounds total-variation error against the declared reference trajectory.

## The phase change

An artifact may have finite standalone life because

\[
\kappa_A=\frac{w_A}{1-\bar\delta_A}>\tau.
\]

The reference is indefinitely safe but expensive. If the reference is contractive, periodic exact steps can pay down artifact debt. The engine searches for a repeating block

\[
A^mR^r
\]

whose affine cycle has a safe invariant fixed point. This can be indefinitely safe and cheaper than reference-only execution even though the artifact alone expires.

The included construction has:

| quantity | value |
|---|---:|
| artifact envelope | \(z'\le0.6z+0.2\) |
| standalone artifact horizon at \(\tau=0.30\) | 1 step |
| reference envelope | \(z'\le0.2z\) |
| synthesized periodic policy | 1 artifact, 1 reference |
| invariant peak debt | 0.2272727273 |
| average cost | 0.525 reference-step equivalents |
| reference-only cost | 1.0 |
| indefinite speedup | 1.9047619× |

The 20-step executable run uses ten artifact steps and ten reference steps, costs 10.5 instead of 20.0, and passes an optional full-reference audit. Setup is billed separately: six reference-step equivalents for discovery and verification, so the first 20-step workload still saves 3.5 equivalents.

## Run

```bash
python -m pytest -q
python -m escrow.demo --json
```

Current verification:

```text
21 passed
```

## What is actually implemented

- executable point artifacts with action-indexed stochastic kernels;
- exact finite membership certification for both artifact and reference;
- proof digests and kernel mutation detection;
- an oracle ledger that bills membership, exact reference, reanchor, discovery, and statistical authority separately;
- Pareto dynamic programming over cost and affine debt;
- exact-reference fallback that contracts rather than magically resets accumulated error;
- periodic-policy synthesis and finite materialization;
- runtime recomputation of all planned debt and cost transitions;
- total-cost and breakeven accounting;
- explicit arrest on malformed plans, changed kernels, failed membership, action mismatch, factor mismatch, or gate violation;
- retained audited quotient utilities, with no claim that they solve scalable quotient discovery.

## What is not claimed

- No full credal set is propagated cheaply. The demo confirms \(|\mathcal P_t|=2^t\), reaching 16,384 explicit trajectories at \(t=14\). Runtime stores one point distribution and one scalar debt bound.
- A singleton family can contain an exceptional row while \(w=0\). Width measures disagreement among declared members, not row weirdness.
- Affine monoid arithmetic prices a composition only after interface and jurisdiction checks. It does not prove composability.
- The neural deployment is not established. The current engine is finite, explicit, and synthetic.
- Literature novelty is not sealed. Dobrushin contraction, imprecise Markov chains, approximate Markov-chain error bounds, Simplex runtime assurance, and switched-system stability are all prior art. The narrow candidate contribution is their proof-carrying integration into a cost-minimizing stochastic-kernel execution scheduler with the periodic debt-paydown theorem and executable receipts.

## Files

- `src/escrow/core.py` — engine, certificates, planner, periodic synthesis, runtime receipts.
- `src/escrow/demo.py` — deterministic experiments and JSON regeneration.
- `tests/test_escrow.py` — hostile tests.
- `MAIN_MODEL.md` — exact system contract.
- `paper/FARTXIV.md` — theorem and empirical write-up.
- `notes/SCHIZONOTE.md` — branch-killing derivation that produced the engine.
- `CLAIMS.md` — claim ledger.
- `collision/EXTERNAL_COLLISION_VERIFICATION.md` — literature boundary.
- `results/demo_results.json` — actual run output.
