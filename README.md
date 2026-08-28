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

## Run what remains

```bash
npm run archied          # local workspace service
npm run archied:hosted   # private hosted wrapper + enrolled runner transport
npm run view             # read-only live engineering view on localhost:8890
npm run verify           # syntax + active-language + transport contract tests
npm run room:ledger -- --room <roast.jsonl>   # fold room events into durable state
```

For the container path, copy `.env.archied.example` to `.env.archied`, replace every placeholder with real local values, then run `docker compose -f compose.hosted.yaml up --build`.

## What remains here

- `scripts/archied.mjs` — local workspace service.
- `scripts/archied-hosted.mjs` — hosted wrapper plus enrolled outbound-runner service.
- `scripts/archie-enrolled-hybrid-runner.mjs` — bounded enrolled worker. Both `archie-enrolled-hybrid-runner` and the legacy `archie-hybrid-runner` package bin names map directly here.
- `scripts/archie-workspace-*.mjs` — digest-bound workspace/event/artifact substrate.
- `scripts/archie-hybrid-protocol.mjs` — enrolled transport protocol.
- `scripts/archie-room-ledger.mjs` — durable fold over the room event log. The read-only surface tails a bounded window, so a reader that reconnects cannot see state older than that window. This keeps a resumable cursor plus folded state in `remote/kai-control.json`, so a later reader resumes at the stored sequence instead of re-deriving from a tail. An obligation opens when a message addresses an agent under an uppercase tag and closes when that agent emits the same tag; whatever stays open is reported as derived work. A room log shorter than the stored cursor is an explicit failure rather than a silent restart at zero.
- `labs/archie-one-surface/index.html` + `labs/archie-one-surface/server.py` — the single read-only representation of live machine truth and retained project state.
- `00-ARCHIE-MODEL/BENCHMARKS.json` — architecture-independent evaluation targets.
- `00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json` — exact historical CPU training receipt provenance retained separately because it contains artifact/run/config digests not duplicated in the compact narrative.
- `ARCHIE_HISTORY_COMPACT.md` — the single compact historical record: positive results, failed branches, hashes, numerical defects, formal findings, language policy, and claim boundaries.

## Rules

Treat model code, evaluation fixtures, transport/runtime infrastructure, UI, and historical experiments as separate categories. A component belongs to the current neural model only when the live trainer dependency graph imports and executes it.

Preserve exact negative evidence and measured receipts. Remove stale scaffolding that exists only to describe other stale scaffolding.

Use mechanism-first language in active prose: evaluation gate, admission status, worker/process, permission scope, explicit failure, monitoring, cancellation, singular value, condition number, and precision sensitivity. Keep historical or serialized compatibility identifiers such as `promotion`, `authority`, or `court` unchanged when renaming them would break schemas, receipts, APIs, paths, or stored evidence; migrate those only explicitly and with compatibility tests.
