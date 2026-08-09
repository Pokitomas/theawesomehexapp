# Archie model evidence package

This directory is an evidence and benchmark entrypoint. It is **not currently authoritative for neural architecture identity**.

The previous package named Qwen3-1.7B plus information-budgeted causal-fork RSLoRA as the canonical executable candidate. That source lane has since been removed from the default branch: its trainer, fuser, profile, workflow, method note, CPU trainer, and training corpus are absent. Continuing to call it current would be false.

## Current truth

- Promotion remains `not-admitted`.
- No independently admitted Archie checkpoint is established here.
- Historical RSLoRA CPU receipts remain preserved in `evidence/HOSTED-LINUX-CPU-RSLORA.json`.
- Those receipts prove only their exact bounded historical runs; they do not identify today's architecture.
- `BENCHMARKS.json` remains useful as an evaluation registry independent of architecture.
- A new canonical model identity must be derived from the current live trainer dependency graph plus exact run receipts.

## Scan order

1. `STATUS.json` — current truth boundary and retired-lane evidence summary.
2. `MODEL.json` — intentionally unresolved current model identity.
3. `BENCHMARKS.json` — architecture-independent admission targets.
4. `evidence/HOSTED-LINUX-CPU-RSLORA.json` — bounded historical RSLoRA receipts.

## Rule

Do not infer the current model from old docs, deleted paths, historical code-search hits, workflow names, or whichever subsystem has the most files. Read the current executable trainer and its direct dependency graph first.
