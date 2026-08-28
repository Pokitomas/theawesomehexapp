# ARCHIE Delta Observable-Component Edge — 2026-08-12

## Boundary

Synthetic exact-arithmetic mechanism court only. This is not evidence that the live resident checkpoint has the same decomposition.

## Exact Delta-specific closure

For the Delta recurrence

`S' = E(k) S + beta k v^T`

with

`E(k) = I - beta k k^T`,

a future read uses `q^T S`.

Backward through an erase,

`q^T E(k) = (q - beta k (k^T q))^T`.

Therefore a query row-space `U` is invariant under a supported erase `E(k)` exactly when either:

- `k` is orthogonal to `U`, so the erase acts as identity on every query in `U`; or
- `k` itself belongs to `U`.

For nonzero beta, the smallest exact future-readable subspace containing a declared query family can therefore be constructed by a fixed-point closure:

1. initialize `U = span(queries)`;
2. if a supported key has nonzero inner product with any vector already spanning `U`, add that key to `U`;
3. repeat until no key enlarges the span.

Equivalently, build a Gram-overlap graph from query nodes to key nodes and between keys. The exact future-readable subspace is the span of keys in components reachable from the declared queries.

## Exact skip consequence

If a supported key `k` lies outside the fixed-point closure, then `k` is orthogonal to every backward-propagated supported query.

Its erase is invisible to those queries, and its write term `beta k v^T` is also invisible.

Thus such key/write events can be skipped exactly for the declared query/action family, provided support remains unchanged.

This is stronger than “state singular value is small” or “channel looks low-rank.” It is a causal, future-law statement specialized to Delta’s rank-1 erase geometry.

## Court result

`archie_delta_observable_component_court_v0.py` uses exact `Fraction` arithmetic.

Clean fixture:

- Delta state row dimension: 12
- observable closure rank: 3
- exactly excluded dimensions: 9
- events: 1,200
- events skipped by the closure certificate: 982
- skipped fraction: 81.8333%
- maximum read error: 0
- exact read match: true

A support mutation then introduces bridge key `e0 + e3`.

Before the bridge, the query-visible component spans coordinates 0..2. Coordinates 3..7 are hidden.

The bridge has overlap with the visible component and a hidden component, so closure propagates through the hidden key chain.

Bridge fixture:

- closure rank before: 3
- closure rank after: 8
- stale-certificate maximum read error: 0.6875
- recomputed-closure maximum read error: 0

The failure is deliberate: a stale component decomposition must not survive a new bridge.

## Real microscope target

Once actual Delta key/query/state/write temporal traces are available, add these measurements per head/layer:

- query-key Gram matrix over windows;
- key-key Gram connectivity;
- rank of the query-seeded invariant closure;
- connected-component sizes and churn;
- principal angles between components across time;
- frequency and magnitude of bridge edges;
- exact/FP32/FP16 read scars from deleting weak components;
- multiscale bridge injections around actual activation ULPs;
- closure growth after held-out future queries and interventions.

The interesting quantity is not merely state SVD rank. It is:

`dimension of the future-query-invariant Delta row space`

and how often that dimension changes.

## Approximate extension

Real learned keys will almost never have mathematically exact zero cross-component dot products.

Do not threshold Gram edges and call the result exact.

Instead:

1. propose a component split from small cross-Gram couplings;
2. bound the omitted coupling at the actual dtype/backend;
3. propagate the induced read/state residual through the Delta recurrence;
4. assign a finite error-tube radius/horizon;
5. inject adversarial bridge perturbations at multiple scales;
6. interrupt/remerge before the error tube crosses the court tolerance.

This connects directly to the existing finite-precision microscope and nonlinear/approximate jurisdiction rules.

## External relation

Recent 2026 work reports low-rank structure in trained linear-attention state and successful structural reduction of key/query channels, while Sparse Delta Memory pursues the opposite capacity direction by making reads/writes sparse over a much larger state.

ARCHIE should not pick either “shrink” or “grow” globally.

The observable-component rule suggests a third architecture:

- maintain large capacity when useful;
- execute only the causally connected Delta component for the current certified query family;
- merge or wake components when a bridge appears;
- let the actual future-law court decide which memory is resident compute versus dormant capacity.

This is the interrupt principle applied inside the recurrent state itself.
