# Archie model reconstruction runbook

The previous RSLoRA dispatch instructions are retired because their named implementation and workflow files are absent from the current default branch.

## Evidence order

1. Identify the currently running or most recent valid trainer from a process observation or exact training receipt.
2. Read that trainer source completely.
3. Follow only its direct imports into the model core and state/memory implementation.
4. Record exact parameter count, vocabulary, dimensions, layer composition, state precision, optimizer, token budget, seeds, and resume semantics from source and receipts.
5. Keep separate courts/specimens separate unless imported into the neural forward path.
6. Freeze a dev/evaluation set and compare the candidate against explicit conventional baselines under matched tokens and seeds.
7. Treat resume timing, throughput gates, leakage, geometry mismatch, and stale observers as validity hazards, not presentation issues.
8. Preserve exact negative evidence.
9. Admit or reject only from the complete evidence chain.

## Historical evidence

`evidence/HOSTED-LINUX-CPU-RSLORA.json` remains a valid bounded record of older CPU RSLoRA experiments. It must not be used as proof of the current model.

## Current state

```text
promotion: not-admitted
current architecture identity: unresolved from repository package alone
historical RSLoRA lane: retired
```
