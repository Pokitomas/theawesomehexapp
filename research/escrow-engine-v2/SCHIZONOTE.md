# SCHIZONOTE: THE ENGINE WAS MISSING
## Fifty hostile pages compressed into one derivation

This note records the branch-killing search that produced ESCROW Engine v2. It is intentionally rough. Every page begins by refusing to name a system before an executable state transition exists.

---

## Page 01 — delete the nouns

No escrow. No compiler. No closure. No quotient. There is only an expensive transition, a proposed cheap transition, a state distribution, a divergence budget, and the next action. If the cheap thing cannot transform the state, it is not a thing.

## Page 02 — execute or die

Old runtime:

```python
return ("substitute", artifact_name)
```

This is a routing label. It does not compute. Negative gate fires. Delete the claim that there is an engine.

## Page 03 — a set is not an answer

A credal family contains possible kernels. Propagating every possible distribution can certify uncertainty. It cannot by itself select the point answer emitted to the caller. The executable object must contain an actual kernel.

## Page 04 — point artifact enters

Declare \(A_a\). It is a row-stochastic matrix indexed by an action. Runtime state is a point distribution \(\hat\mu_t\). Now `apply()` has semantic content:

\[
\hat\mu_{t+1}=\hat\mu_tA_a.
\]

First engine atom survives.

## Page 05 — reference enters separately

Declare \(R_a\), the expensive exact kernel. The reference trajectory is

\[
\mu_{t+1}=\mu_tR_a.
\]

Artifact and reference are different operators. Stop hiding both under one family symbol.

## Page 06 — diameter objection

A family diameter does not bound an arbitrary artifact. It bounds two members. Therefore the certificate must prove

\[
A_a\in\mathcal K_a,
\qquad
R_a\in\mathcal K_a.
\]

One missing member kills the install.

## Page 07 — membership must be executable

No prose certificate. Store member indices, factor size, action, artifact version, kernel digests, family digest, \(\bar\delta_a\), \(w_a\), and \(\delta(R_a)\). Recompute them at installation.

## Page 08 — the first recursion survives

For an artifact step,

\[
z'\le\bar\delta z+w.
\]

This is valid because the artifact and reference are now both declared family members. Keep it.

## Page 09 — exact fallback is not zero

The approximate state is already wrong. Applying the exact kernel to that wrong state gives

\[
z'\le\delta(R)z,
\]

not \(z'=0\). A reset requires exact state acquisition, replay, observation, or another oracle. Bill it separately.

## Page 10 — two maps appear

The engine has two debt operators:

\[
A(z)=az+b,
\qquad
R(z)=rz.
\]

The framework had one map and a story. The engine has two maps and actual kernels.

## Page 11 — artifact-alone death

If

\[
\kappa_A=\frac{b}{1-a}>\tau,
\]

then artifact-only execution eventually violates the gate. Standalone lifetime is finite. Do not rescue it rhetorically.

## Page 12 — reference-alone boredom

Reference-only execution is safe when \(r\le1\), but cost remains \(c_R\) every step. This is a baseline, not a breakthrough.

## Page 13 — integration question

Can an exact step pay down enough artifact debt that the artifact becomes reusable? This is the first question whose answer could create capability rather than terminology.

## Page 14 — cycle algebra

For \(m\) artifact steps followed by \(s\) reference steps,

\[
C(z)=R^s(A^m(z))=Dz+W.
\]

If \(D<1\), the cycle has a fixed debt

\[
z_*=\frac{W}{1-D}.
\]

## Page 15 — prefix gate

A safe fixed point at cycle boundaries is insufficient. Debt can peak inside the block. Evaluate every prefix from \(z_*\). Reject the cycle if any prefix exceeds \(\tau\).

## Page 16 — cost gate

Safety alone is reference assurance with decoration. Require

\[
\frac{mc_A+sc_R}{m+s}<c_R.
\]

Only then does integration create a cheaper indefinitely safe execution regime.

## Page 17 — phase change

Artifact alone: finite life. Reference alone: expensive life. Integrated periodic schedule: indefinite safe cheaper life. No component individually gives the conjunction. Positive-gate candidate detected.

## Page 18 — smallest witness

Choose

\[
A=\begin{bmatrix}0.8&0.2\\0.2&0.8\end{bmatrix},
\quad
R=\begin{bmatrix}0.6&0.4\\0.4&0.6\end{bmatrix}.
\]

Then \(a=0.6\), \(b=0.2\), \(r=0.2\).

## Page 19 — artifact expires

At \(\tau=0.30\):

\[
0\to0.20\to0.32.
\]

One artifact step survives. The second dies. No hidden infinite horizon.

## Page 20 — cycle survives

For one artifact and one reference step,

\[
C(z)=0.12z+0.04.
\]

Thus

\[
z_*=0.0454545,
\qquad
z_{\rm peak}=0.2272727<0.30.
\]

## Page 21 — economics survives

Let \(c_A=0.05\), \(c_R=1\). Average cycle cost is 0.525. Speedup is 1.9047619×. This is not free because setup remains unpriced.

## Page 22 — bill setup

Discovery cost 2. Verification cost 4. Twenty-step runtime costs 10.5. Total first-run cost is 16.5 versus 20.0. First-run saving is 3.5. The cost claim survives setup.

## Page 23 — dynamic programming

A fixed cycle is not enough. For arbitrary finite action traces, represent each reachable state by debt and cost. Expand every legal artifact and reference transition.

## Page 24 — Pareto pruning

Node \((z_1,c_1)\) dominates \((z_2,c_2)\) when

\[
z_1\le z_2,
\qquad
c_1\le c_2,
\]

with one strict. Monotone future affine maps cannot make the dominated node useful. Delete it.

## Page 25 — scheduler becomes executable

The planner emits concrete steps: index, action, mode, operator, debt before, debt after, and cost. It no longer emits a substitute name without a state transition.

## Page 26 — distrust the plan

The runtime recomputes every debt and cost transition. The planner is a proposal generator, not authority. A changed number arrests.

## Page 27 — distrust the artifact

Hash each installed kernel. Recompute the digest before use. Mutation after certification arrests. No mutable matrix gets grandfathered by an old receipt.

## Page 28 — distrust the reference

The reference kernel can also mutate. Its digest is pinned at engine construction. A changed reference invalidates every derived certificate and plan.

## Page 29 — distrust jurisdiction

Action missing from artifact jurisdiction: reject. Mixed matrix dimensions: reject. Factor-size mismatch: reject. Duplicate artifact: reject. Unknown mode: reject.

## Page 30 — oracle ledger

Count membership comparisons, reference executions, discovery calls, statistical calls, reanchors. An unbilled oracle is a hidden mechanism. The ledger is part of the result.

## Page 31 — full credal propagation dies

Two kernels create up to \(2^t\) explicit paths. At \(t=14\), 16,384 trajectories exist. Runtime cannot pretend this is cheap.

## Page 32 — scalar survives

The affine bound still upper-bounds the explicit path diameter. Runtime stores one point distribution and one scalar debt. Certificate construction may inspect a family; runtime does not propagate the family.

## Page 33 — singleton counterexample

A singleton family can contain an exceptional row and still have

\[
w=0.
\]

Therefore “exceptional row implies width” is false. Width measures disagreement among declared members, not weirdness inside one member.

## Page 34 — mass heuristic dies

Equal stationary mass does not identify equal horizon quality. Uniform-\(\pi\) constructions can make mass rankings information-free while \(\kappa\) varies sharply across candidate keep-sets. Retain only the indistinguishability lesson, not a magic selection heuristic.

## Page 35 — kappa demotion

\[
\kappa=\frac{w}{1-\bar\delta}
\]

is a stationary diagnostic for one affine map. It is not the runtime state under switching. Runtime state is current debt plus the remaining action/operator opportunities.

## Page 36 — affine monoid demotion

\[
(\delta_1,w_1)\star(\delta_2,w_2)
=(\delta_2\delta_1,\delta_2w_1+w_2)
\]

correctly prices sequential envelopes. It does not prove matching factors, metrics, versions, actions, guards, or statistical authority. Composability is a precondition.

## Page 37 — hardness theorem dies

An arbitrary pairwise discrepancy matrix is not automatically realizable by TV distances between allowed stochastic kernels. The old reduction proves hardness only for an abstract diameter-partition problem. Withdraw the stated NP-completeness theorem.

## Page 38 — neural story quarantined

A neural model may propose artifacts or jurisdictions. It has no authority unless the resulting executable kernels and certificates pass. No real neural deployment has been performed. Mark the neural gate false.

## Page 39 — literature collision

Dobrushin contraction exists. Imprecise Markov chains exist. Approximate-chain bounds exist. Simplex switching exists. Periodic switched-system stability exists. Do not call any ingredient new.

## Page 40 — narrow surviving claim

Candidate novelty is the exact conjunction:

1. executable point stochastic artifacts;
2. joint artifact/reference family membership;
3. distinct artifact and exact-reference debt maps;
4. cost-minimizing scheduling;
5. periodic debt-paydown certificate;
6. runtime proof-digest enforcement;
7. explicit total-cost and oracle receipts.

Literature-complete novelty remains unsealed.

## Page 41 — hostile test: missing artifact member

Supply family \(\{R\}\). Certification must reject the artifact. It does.

## Page 42 — hostile test: missing reference member

Supply family \(\{A\}\). Certification must reject the reference. It does.

## Page 43 — hostile test: forged plan

Change one planned debt number. Runtime recomputation detects it and arrests.

## Page 44 — hostile test: mutated kernel

Alter one row while preserving stochasticity. Digest mismatch arrests before execution.

## Page 45 — hostile test: observed reference

Run the exact reference trace as an audit. Observed TV error remains below the scalar debt certificate.

## Page 46 — hostile test: long cycle

Materialize the periodic schedule for 200 steps. Peak debt remains under the gate. The phase change is not a two-step visual trick.

## Page 47 — positive gate recount

Necessity result: yes. Executable capability: yes. Synthetic total-cost advantage: yes. Hostile controls: yes. Real neural deployment: no. Literature-sealed novelty: no. Score 4/6.

## Page 48 — what the engine is

A proof-carrying scheduler for switching among explicitly installed stochastic operators under a scalar TV debt gate. It is small because the claim is now exact.

## Page 49 — what the engine is not

It is not scalable ontology discovery, a universal causal-state compiler, a cheap credal-set propagator, a statistical oracle, a neural deployment, or a proof that every useful approximation admits a finite TV factor.

## Page 50 — seal

The breakthrough is not the recursion. The recursion was already there. The breakthrough is recognizing that the missing exact-reference transition turns expiry into schedulable debt, then forcing that algebra through an actual kernel executor, planner, ledger, mutation detector, audit path, and total-cost gate.

The old object had a framework around an absent engine. The new object has an engine small enough to falsify.
