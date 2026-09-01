# ESCROW on the Integrated Archie Sidepus Checkpoint

## Technical summary

**Verdict: the engine is executable, but the claimed real-model breakthrough fails.** The 123,265,923-parameter Sidepus checkpoint executed directly on CPU across 24 disjoint repository files, 12 persistent-state chunks per file, and five depth configurations. The custom 20-layer path matched the shipped model exactly (`max |Δlogit| = 0`).

Raw early exits were unusable. The 16-layer executor cost 0.768 of the reference but produced mean next-token TV 0.441. A 165,760-parameter residual MLP improved cost to 0.736, mean TV to 0.187, and top-1 agreement to 0.760.

The apparent 26.4% certified saving was **vacuous**. The selected two-state factor made artifact and reference transition kernels identical, reporting zero factor debt while actual switched execution had mean output TV 0.194, maximum TV 0.890, and final persistent-state relative L2 0.111. A factor-size sweep from 1 to 32 found no factor that had both transition support and a useful decoder bound.

The surviving contribution is narrower: **factor debt must be lifted through a certified common decoder before it can authorize observable behavior.** The observable-lifting lemma and fail-closed implementation are in `observable_gate.py`.

## The real checkpoint invalidates the toy economics

The initial uncorrected experiment used genuine 4/8/12/16-layer executors and the full 20-layer reference while carrying world and plastic state across chunks. At gates through `tau = 0.50`, the planner selected the reference for all 88 test transitions. At `tau = 0.70`, it selected only four 16-layer steps and projected cost 0.993 instead of 1.000—less than 1% savings.

This is the first death condition: a scheduler cannot rescue an artifact whose error/cost frontier is poor.

## Residual correction improves the artifact, not the certificate

A tokenwise MLP learned to approximate the missing final four-layer residual on 6,144 calibration token states. It uses 165,760 parameters, about 0.13% of the checkpoint. On disjoint test files it reduced mean next-token TV from 0.441 to 0.187 while its measured CPU cost ratio was 0.736.

This is a real engineering improvement, but it is not sufficient for a hard fidelity claim. Test p95 TV remained 0.425 and maximum TV reached 0.890.

## The factor erased the error

The pooled hidden-state factor selected by the first engine pass had two states. One factor row was unsupported, yet pseudocount smoothing produced complete stochastic matrices. Artifact and reference matrices became identical, so the certificate reported zero debt and scheduled the artifact for every transition.

That result directly falsifies the proposition that a valid factor-transition bound is automatically an output guarantee. The factor controlled its own labels but failed to preserve the declared next-token observable.

## No tested factor closes the decoder-support tradeoff

A second sweep defined factors directly on the 260-way output distributions and bound each factor state to a common decoder distribution. At `K = 1`, transition support was complete and kernel width was zero, but mean decoder TV was about 0.75 and the worst-case observable floor was 1.0. Increasing `K` reduced average decoder error, but unsupported transition rows appeared from `K = 8` onward. Even `K = 32` retained test mean decoder TV 0.366 for the reference and 0.340 for the artifact, with 31 and 30 unsupported rows respectively.

No tested factor simultaneously supplied:

- complete row/action coverage;
- a nonvacuous observable decoder;
- a useful worst-case TV threshold;
- and a cost advantage over exact execution.

## Scope and method

- **Reference:** integrated Archie Sidepus pursuit checkpoint, 123,265,923 parameters.
- **Approximate executors:** first 4, 8, 12, or 16 trained backbone layers; later a 16-layer executor plus a learned 165,760-parameter residual MLP.
- **Persistent state:** 12 world-state slots and rank-16 plastic memory were carried between 32-byte chunks.
- **Data:** 16 calibration and 8 test files selected deterministically from distinct repository paths; each contributed 12 chunks.
- **Timing:** CPU medians in the experiment container, normalized to the 20-layer reference.
- **Certification metric:** total variation on empirical finite-state transition operators.
- **Observable metric:** total variation between 260-way next-token distributions, plus top-1 agreement and final persistent-state relative L2.

## Observable lifting lemma

Let `G` be one common stochastic decoder from factor states to the declared observable. If

```text
TV(P_art, mu_art G) <= eps_art
TV(P_ref, mu_ref G) <= eps_ref
TV(mu_art, mu_ref) <= z
```

then

```text
TV(P_art, P_ref) <= eps_art + z + eps_ref.
```

The proof is triangle inequality plus TV data processing through `G`. Therefore runtime admission must charge both decoder residuals in addition to factor debt. A one-state quotient proves necessity: factor debt is zero even when concrete observables differ arbitrarily.

## Limitations and robustness

The test files are disjoint from calibration files, but they are not proven absent from the checkpoint's original training corpus. The finite transition kernels are empirical abstractions, not population truths. CPU timings are not an RTX 2060 deployment receipt. The original planner had full knowledge of fixed-document chunk classes; autoregressive deployment would require online or receding-horizon planning.

The negative conclusion does not depend on timing noise: it follows from the direct mismatch between zero factor debt and large observable error, plus unsupported rows in every nontrivial factor family tested.

## Scientific verdict

**Not new science yet.** The specific proof-carrying scheduler remains a plausible integration, but this experiment shows its previous certificate omitted the decisive observable decoder obligation.

The new defensible claim is:

> A proof-carrying switched executor needs both a transition-debt certificate and an observable-decoder certificate. Either one alone can be vacuous.

This is a necessary repair theorem and a reproducible real-model counterexample, not a demonstrated systems breakthrough.

## Next experiment that earns compute

Train the early-exit artifact jointly with:

1. final-distribution distillation;
2. persistent-state alignment;
3. a factor-decoder residual loss;
4. active sampling of unsupported factor rows;
5. a held-out corpus proven absent from training.

Then compare against full reference, fixed-period fallback, confidence-threshold early exit, self-speculative verification, and Simplex-style fallback on the same GPU and total-cost ledger. Do not rerun the current scheduler before the observable gate passes.
