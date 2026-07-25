# The Engine Was Missing
## Proof-Carrying Scheduling of Approximate and Exact Stochastic Operators Under Affine Error Debt

**Kai Manangon — FARTXIV preprint, July 24, 2026**  
Not affiliated with arXiv.

## Abstract

An uncertainty recursion is not an engine. The previous ESCROW object could bound the diameter of a propagated credal family and calculate an expiry horizon, but its runtime returned the name of a substitute without executing one. This paper replaces that selector with a finite stochastic execution engine.

For each action, a cheap point artifact and the exact reference must both be explicit members of a declared credal family. An artifact step obeys

\[
z_{t+1}\le \bar\delta_a z_t+w_a,
\]

while applying the exact reference kernel to the current approximate state obeys

\[
z_{t+1}\le \delta(R_a)z_t.
\]

The second transition creates the central phase change. A cheap artifact can expire when run alone, while periodic exact steps pay down its accumulated debt. The integrated schedule can therefore be safe forever and cheaper than exact-only execution even though neither component supplies that combination alone.

The engine installs proof-carrying artifacts, recomputes membership certificates, searches the Pareto frontier of cost and debt, executes explicit stochastic kernels, and arrests on changed kernels, malformed plans, jurisdiction mismatch, failed membership, or gate violation. In the included construction, the artifact has standalone horizon one at a TV gate of 0.30, but a one-artifact/one-reference cycle has invariant peak debt 0.2272727273 and costs 0.525 per step relative to exact cost 1.0, an indefinite 1.9047619× speedup in the declared model.

The result is deliberately finite and synthetic. Dobrushin contraction, imprecise Markov chains, approximate-chain perturbation bounds, runtime-assurance switching, and switched-system stability are prior art. The narrow surviving candidate contribution is their proof-carrying integration into a cost-minimizing executable scheduler with a separate exact-reference debt-paydown law.

## 1. Failure of the former object

The old framework made four invalid leaps.

1. A propagated set was treated as a point substitute.
2. Set diameter was treated as artifact error without proving that both artifact and reference were members.
3. exact fallback was treated as a zero-error reset without acquiring the exact current state.
4. affine composition was treated as interface certification.

The repaired engine refuses all four.

## 2. Finite stochastic setting

Let \(Q=\{1,\dots,n\}\) and let \(a\) range over a finite action alphabet. The exact reference has a row-stochastic kernel \(R_a\). A point artifact has an executable row-stochastic kernel \(A_a\) on its declared jurisdiction.

For distributions \(p,q\),

\[
\|p-q\|_{\mathrm{TV}}=\frac12\sum_i|p_i-q_i|.
\]

For a kernel \(K\),

\[
\delta(K)=\max_{i,j}\|K(\cdot\mid i)-K(\cdot\mid j)\|_{\mathrm{TV}}.
\]

The standard contraction inequality is

\[
\|pK-qK\|_{\mathrm{TV}}\le\delta(K)\|p-q\|_{\mathrm{TV}}.
\]

For each action, installation receives a finite family \(\mathcal K_a\). It accepts only when both \(A_a\in\mathcal K_a\) and \(R_a\in\mathcal K_a\) by explicit matrix equality. Define

\[
\bar\delta_a=\max_{K\in\mathcal K_a}\delta(K)
\]

and

\[
w_a=\max_q\max_{K,K'\in\mathcal K_a}
\|K(\cdot\mid q)-K'(\cdot\mid q)\|_{\mathrm{TV}}.
\]

The certificate binds the family, kernels, member indices, factor size, artifact name, version, action, and proof digest.

## 3. Two transitions, not one

Let \(z_t\) certify

\[
\|\hat\mu_t-\mu_t\|_{\mathrm{TV}}\le z_t.
\]

### Theorem 1 — artifact transition

When the approximate trajectory applies \(A_a\) and the reference trajectory applies \(R_a\),

\[
\|\hat\mu_tA_a-\mu_tR_a\|_{\mathrm{TV}}
\le \bar\delta_a z_t+w_a.
\]

**Proof.** Insert and subtract \(\mu_tA_a\). The first term contracts by \(\delta(A_a)\le\bar\delta_a\). The second is a convex mixture of row discrepancies between two declared family members and is at most \(w_a\). ∎

### Theorem 2 — exact-reference paydown

When both trajectories apply \(R_a\),

\[
\|\hat\mu_tR_a-\mu_tR_a\|_{\mathrm{TV}}
\le \delta(R_a)z_t.
\]

This is not a reset. It is a zero-slack contraction of existing debt. A true reset requires exact state acquisition or replay and must be separately billed.

## 4. Periodic phase change

Write one artifact debt map as

\[
A(z)=az+b
\]

and one reference debt map as

\[
R(z)=rz,
\]

where \(0\le a,r\le1\), \(b\ge0\). Consider a repeating block \(A^mR^s\). Its cycle map is affine:

\[
C(z)=Dz+W.
\]

For the ordering above,

\[
D=r^sa^m,
\qquad
W=r^sb\sum_{j=0}^{m-1}a^j.
\]

### Theorem 3 — periodic safety certificate

Assume \(D<1\). Let

\[
z_*=\frac{W}{1-D}.
\]

If every prefix debt encountered while applying the \(m\) artifact steps and \(s\) reference steps from \(z_*\) is at most the runtime gate \(\tau\), then repeating the block forever is safe. Its long-run average execution cost is

\[
\bar c=\frac{mc_A+sc_R}{m+s}.
\]

When \(\bar c<c_R\), the periodic engine is indefinitely safe and cheaper than reference-only execution.

**Proof.** \(z_*\) is the fixed point of the cycle. Starting at \(z_*\), every completed block returns to \(z_*\). The prefix condition bounds all intermediate debts. Starting below \(z_*\), monotonicity of the affine maps keeps the trajectory no larger. The cost identity is direct. ∎

This is the integration result. Artifact-only execution can fail the infinite-horizon gate because \(b/(1-a)>\tau\). Reference-only execution can pass but remain expensive. Their certified periodic composition can pass both safety and cost gates.

## 5. Concrete construction

Use

\[
A=\begin{bmatrix}0.8&0.2\\0.2&0.8\end{bmatrix},
\qquad
R=\begin{bmatrix}0.6&0.4\\0.4&0.6\end{bmatrix}.
\]

For the family \(\{A,R\}\),

\[
\bar\delta=0.6,
\qquad
w=0.2,
\qquad
\delta(R)=0.2.
\]

Thus

\[
A(z)=0.6z+0.2,
\qquad
R(z)=0.2z.
\]

At \(\tau=0.30\), artifact-only execution is safe for one step and fails on the second:

\[
0\mapsto0.2\mapsto0.32.
\]

For the cycle \(AR\),

\[
C(z)=0.12z+0.04.
\]

Therefore

\[
z_*=\frac{0.04}{0.88}=0.045454545455,
\]

and the peak after the artifact step is

\[
0.6z_*+0.2=0.227272727273<0.30.
\]

With artifact cost \(c_A=0.05\) and reference cost \(c_R=1\),

\[
\bar c=\frac{0.05+1}{2}=0.525,
\qquad
\text{speedup}=\frac1{0.525}=1.904761904762.
\]

## 6. Finite-horizon scheduler

For an action trace \(a_0,\dots,a_{T-1}\), each legal operator induces a transition

\[
(z,c)\mapsto(T_o(z),c+c_o).
\]

The planner performs dynamic programming over reachable debt-cost pairs. A node dominates another node when it has no greater cost and no greater debt, with one strict inequality. Dominated nodes can never improve any future monotone affine continuation and are removed.

The surviving Pareto frontier yields the least-cost safe plan under the declared finite operator set and scalar certificate model.

In the 20-step construction, the planner selects ten artifact steps and ten reference steps. Runtime cost is 10.5 rather than 20.0. Six setup equivalents are billed for discovery and verification, so the first workload costs 16.5 total and still saves 3.5. The second identical workload brings cumulative cost to 27 rather than 40.

## 7. Runtime distrusts the planner

The runtime does not accept a plan as authority. At each step it independently checks:

- step index and action;
- operator jurisdiction;
- current reference-kernel digest;
- installed artifact-kernel digest;
- certificate identity and version;
- recomputed affine debt;
- recomputed execution cost;
- gate compliance;
- final debt and cost totals.

A discrepancy arrests execution. Optional audit runs the full exact reference trace and verifies that observed TV error is below the certified debt.

## 8. Why full credal propagation is not the runtime

For a family of two kernels, naive explicit propagation can double the number of represented trajectories each step. The included test realizes

\[
|\mathcal P_t|=2^t,
\]

reaching 16,384 trajectories at \(t=14\). The scalar affine recursion continues to bound the diameter, but it does not make explicit set propagation cheap.

The engine therefore stores one executable point distribution and one scalar debt bound. The credal family is a certificate input, not the runtime state.

## 9. Corrections and withdrawals

The repaired claim ledger records:

- **withdrawn:** a singleton exceptional row necessarily inflates width. A singleton family has \(w=0\), regardless of row shape.
- **withdrawn:** diameter automatically bounds arbitrary artifact error. Both artifact and reference membership are required.
- **withdrawn:** affine monoid composition proves interfaces compatible. It prices only separately certified composition.
- **withdrawn:** cheap runtime propagates the full credal set.
- **withdrawn:** the original NP-completeness theorem for TV-realizable stochastic kernels. The former reduction established only an abstract diameter-partition problem; TV realizability remains open.
- **withdrawn:** exact fallback resets debt to zero without exact state reacquisition.
- **demoted:** \(\kappa=w/(1-\bar\delta)\) is a stationary diagnostic, not a complete runtime state.

## 10. Verification

The full sealed bundle passes 21 hostile tests. The standalone GitHub cut passes six tests covering:

1. finite artifact horizon plus safe periodic phase change;
2. executable 20-step plan and observed-error audit;
3. joint membership requirement;
4. singleton-width counterexample;
5. plan-tampering and kernel-mutation arrest;
6. exponential explicit credal-path growth with a surviving scalar bound.

## 11. Claim boundary

Established here:

- executable point artifacts;
- joint artifact/reference membership certificates;
- separate artifact and reference debt transitions;
- closed-form periodic safety certificate;
- finite least-cost safe planning in the implemented finite model;
- fail-closed runtime receipts;
- synthetic total-cost advantage.

Not established:

- scalable discovery of useful artifacts;
- a real neural or transformer deployment;
- robust statistical membership under continuous uncertainty;
- literature-complete novelty;
- optimality beyond the declared finite operator/debt abstraction;
- TV realizability of the withdrawn hardness construction.

The framework had no engine. This version does.
