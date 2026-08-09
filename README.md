# Archie

Archie is an experimental local-first model and execution system. This repository now intentionally contains only the small workspace/transport runtime, one representation surface, architecture-independent evaluation targets, and compact historical evidence.

## Current empirical state

The repository does **not** establish the current neural architecture or an admitted checkpoint. Reconstruct current model identity from the live trainer, its direct dependency graph, exact configuration, and run receipts.

```text
admission status: not admitted
admitted checkpoint: none established in repository
current neural identity: resolve from live executable source + receipts
```

Observed Aug-8 live source boundary:

`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`

The exact recorded source hashes and retained numerical/training history are in `ARCHIE_HISTORY_COMPACT.md`. Do not synthesize current typed-Delta code from retired repository implementations.

## What remains here

- `scripts/archied.mjs` — local workspace service.
- `scripts/archied-hosted.mjs` — hosted wrapper plus enrolled outbound-runner service.
- `scripts/archie-enrolled-hybrid-runner.mjs` — bounded enrolled worker.
- `scripts/archie-hybrid-runner.mjs` — thin compatibility alias for the enrolled worker.
- `scripts/archie-workspace-*.mjs` — digest-bound workspace/event/artifact substrate.
- `scripts/archie-hybrid-protocol.mjs` — enrolled transport protocol.
- `labs/archie-one-surface/index.html` + `labs/archie-one-surface/server.py` — the single read-only representation of live machine truth and retained project state.
- `00-ARCHIE-MODEL/BENCHMARKS.json` — architecture-independent evaluation targets.
- `ARCHIE_HISTORY_COMPACT.md` — the single compact historical record: positive results, failed branches, hashes, numerical defects, formal findings, and claim boundaries.
- `ENGINEERING_LANGUAGE.md` — mechanism-first vocabulary for active engineering prose.

## Rule

Treat model code, evaluation fixtures, transport/runtime infrastructure, UI, and historical experiments as separate categories. A component belongs to the current neural model only when the live trainer dependency graph imports and executes it.

Preserve exact negative evidence and measured receipts. Remove stale scaffolding that exists only to describe other stale scaffolding.
