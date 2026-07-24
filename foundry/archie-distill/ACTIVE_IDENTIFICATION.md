# Archie Active Identification v1

## Decision

PR #755 is a terminal null result. Genetic search over bounded instruments did not recover signal distinguishable from matched random programs. The successor does not tune thresholds or enlarge the evolutionary search.

## Reversal

Discovery now begins with **designed interventions**, not candidate programs.

The system must first establish that the raw interface contains a recoverable causal response under a fixed budget. Only after that proof may it synthesize compact executable instruments.

## Stage 0 — falsifiable interface audit

For each action, execute balanced pulse, anti-pulse, block, alternating, and pseudorandom binary sequences from matched reset states. Estimate action-to-observation impulse responses for every lag and channel.

Required evidence:

1. The real action labels beat episode-wise and time-wise permutation nulls.
2. A delay estimate is stable across seeds.
3. At least one response subspace transports under channel permutation after explicit remapping.
4. Held-out intervention outcomes are predicted above a history-only baseline.

If these fail, stop. There is no instrument search.

## Stage 1 — response-coordinate construction

Construct coordinates from cross-covariance and finite-horizon response matrices using only raw observations and actions. Candidate coordinates are admitted by rank stability, bootstrap confidence, intervention prediction, and null separation.

No genetic operators. No downstream utility objective. No hidden-state access.

## Stage 2 — bounded executable compression

Only after response coordinates pass Stage 1, fit bounded programs to approximate them. Program synthesis is now compression of an already identified causal coordinate, not blind discovery.

The executable program must preserve:

- response correlation on held-out episodes;
- intervention prediction;
- transport after declared channel remapping;
- ablation damage;
- exact serialization and reconstruction.

## Stage 3 — agency court

A compressed instrument is scientifically admitted only when its removal changes intervention selection and worsens realized return on sealed worlds. Prediction-only improvements are recorded as representation, not agency.

## Non-negotiable nulls

- No threshold changes after sealed evaluation.
- No teacher proposals.
- No oracle features in discovery or compression.
- No world edits motivated by failed results.
- No aggregate pass inferred from plumbing, tests, or source structure.

## First executable milestone

Produce a receipt containing:

- intervention sequences and reset hashes;
- lagged response matrices;
- permutation-null distributions;
- bootstrap intervals;
- estimated delay;
- response rank and stability;
- held-out intervention prediction;
- transport result;
- explicit `interface_identifiable: passed|failed`.

Until `interface_identifiable` passes, every later gate is `not_testable`, not `failed` and not simulated.