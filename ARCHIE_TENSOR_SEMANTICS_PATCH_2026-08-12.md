# ARCHIE Tensor Semantics Patch — 2026-08-12

## Epistemic correction

The tensor microscope is a diagnostic instrument, not an architecture judge.

Stable rank, conditioning, FP16 round-trip error, JVP/finite-difference agreement, activation sparsity, and hidden-state separation can reveal numerical or geometric facts. None of those facts, by themselves, imply that the composed network computes a useful task function.

Accordingly:

- local tensor "health" is **diagnostic evidence only**;
- ordinary held-out task/objective evidence is restored as a required semantic court;
- mechanism-specific causal interventions may complement task loss, but may not replace semantics with geometry;
- low rank, saturation, sparsity, erasure, or divergent dynamics are not defects unless a task-conditioned intervention demonstrates harm;
- near-state / divergent-future collision measurements are descriptive, not automatic suspects;
- random hidden-state Rademacher gradients are not to be compared against Adam moments as though disagreement were evidence of optimizer pathology. Adam is driven by task-loss gradients; random hidden probes answer a different question.

The strongest surviving component of the microscope is the Delta write holonomy court because it interrogates the actual semantics of the memory update map.

## Exact Delta write holonomy

For a write

`T(S) = (I - beta k k^T) S + beta k v^T`,

two writes have order defect

`DeltaS = T_b(T_a(S)) - T_a(T_b(S))`

`= beta_a beta_b c [ (k_b k_a^T - k_a k_b^T) S + k_a v_b^T - k_b v_a^T ]`,

where `c = k_a^T k_b`.

This separates address-plane rotation from value conflict and is genuine architecture-specific local physics.

## Causal abstraction to observable behavior

Let a bank of downstream memory queries be `Q in R^{M x K}` and a linear value-to-output observation map be `W in R^{V x C}`. Then the behavioral effect of write order is exactly

`DeltaL = Q DeltaS W`.

This gives the correct replacement for a vague demand that hidden holonomy and output behavior be globally bijective.

### Single-read non-identifiability

A single query is not generally injective. Delta holonomy lies in the key-row span of the two write keys. Choose a query `q` orthogonal to both `k_a` and `k_b`; then a nonzero `DeltaS` can satisfy

`q^T DeltaS = 0`.

Therefore a single output read can completely miss real internal holonomy.

### Causal-quotient bijection theorem

If

- `rank(Q) = K` (the query family spans the key space), and
- `rank(W) = V` (the output map is injective on the value space),

then

`DeltaS = Q^+ DeltaL W^+`.

So the map from state holonomy to behavioral holonomy is bijective **onto its image**. This is the lawful notion of semantic identifiability: not a global one-to-one map between arbitrary hidden states and logits, but an informationally complete causal observation family for the mechanism under study.

The new framework-independent reference court `foundry/causal_holonomy_court.py` executes this theorem and explicit nullspace counterexamples.

Local NumPy reference result, seed 20260812:

- closed-form holonomy relative error: `2.631101711810176e-15`
- complete-observation reconstruction relative error: `1.059859177342531e-15`
- query rank: `8 / 8`
- output rank: `32 / 32`
- nonzero holonomy hidden from one query: state norm `1.1093394341292226`, behavioral norm `7.210984227910757e-16`
- nonzero pure value-conflict holonomy hidden by a rank-deficient output map: state norm `0.4489000000000002`, behavioral norm `3.649536815607278e-15`
- optimal scalar order signal equals top singular value: `0.8710848501335974` vs `0.8710848501335979`
- shared-state AB/BA difference norm: `1.1093394341292226`
- context-fission product-state AB/BA difference norm: `0.0`
- court status: `pass`

## Context fission is task-conditional

The earlier context-fission result is mathematically valid but was epistemically overinterpreted.

Splitting A and B into disjoint fibers makes their writes commute and removes cross-order holonomy. That is beneficial only when write order is a nuisance variable that the task should ignore.

If the task requires order discrimination, shared-state holonomy is a usable signal: the top singular vectors of `DeltaS` define an optimal scalar readout whose order effect equals `sigma_max(DeltaS)`. Context fission makes the product state identical under AB and BA, so it destroys that order channel unless order is represented somewhere else.

Therefore no future court may label "lower holonomy" as automatically better. The required question is: **should this distinction affect behavior for this task?**

## Promotion rule

A mechanism may be promoted only when all three levels agree:

1. **local physics** — exact operator/math court;
2. **causal semantics** — controlled intervention maps the mechanism to output/task behavior;
3. **held-out function** — ordinary task/objective evaluation verifies that the composed system benefits.

Geometry can falsify implementation claims. It cannot substitute for function.

## Next experiment

Integrate the causal-holonomy observable into the actual Delta model:

- capture real write keys, values, betas, memory state, and downstream query family;
- compute predicted `DeltaS` from the closed form;
- execute AB vs BA counterfactual writes without retraining;
- measure actual downstream logit/decision effect `DeltaL`;
- estimate the rank of the real query and value-to-output maps;
- classify each observed holonomy direction as observable, hidden, task-helpful, task-neutral, or task-harmful;
- compare shared-state and context-fission variants on both order-sensitive and order-invariant held-out tasks.

The goal is not to prove the microscope right. The goal is to turn one architecture-specific mathematical discovery into a causal semantic theory that can survive counterexamples and then be replaced when a stronger theory appears.
