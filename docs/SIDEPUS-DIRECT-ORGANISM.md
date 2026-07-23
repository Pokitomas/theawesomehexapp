# Archie Direct Sidepus Organism

## Purpose

Train Archie from immutable Sidepus archive objects without flattening the archive into a second monolithic token corpus. The campaign combines four mechanisms in one candidate:

1. selective-SSM/local-attention recurrence;
2. token-local plastic fast weights;
3. sparse quantized persistent world-state slots;
4. adaptive differentiable deliberation with a learned halting distribution.

The current 114M run remains the language parent. This lane starts only after that parent has a complete receipt.

## Data path

```text
WARC/ARC/WACZ holdings
  -> Sidepus content-addressed object store
  -> rights-approved developmental inventory
  -> sealed replay plan containing only object hashes, record IDs and token-window digests
  -> parallel object prefetch and episode rendering
  -> GPU batch
```

Archive payloads stay in the Sidepus SHA-256 object store. A training plan is replay metadata, not a copied corpus. Every replayed episode and final uint16 token window is digest checked.

## Episode channels

The multichannel arm preserves:

- production context;
- raw or content-addressed observation;
- situated utterance;
- extraction interpretation;
- action consequence when present.

Matched controls use the same source selection under flattened, utterance-only, reset-state and static-language conditions.

## Campaign

```text
complete 114M parent
  -> Q8 integrated organism discovery
  -> Q4 continuation
  -> correct carried vs reset vs wrong-history state
  -> world-only and plastic-only ablations
  -> ordinary-language retention
  -> flattened/reset/static controls
  -> select Q8 or Q4 only if causal gates pass
  -> rebuild from the parent with a second seed
  -> repeat the frozen causal evaluation
  -> export only a replicated research candidate
```

## Required local inputs

- completed `returns/generative-114m/archie-hybrid-114m.pt`;
- completed base training receipt;
- Sidepus archive state, default `~/sidepus-archive-v2`;
- a verified rights-approved developmental inventory;
- the base development corpus for retention.

When no inventory exists, the launcher can extract one only when `ARCHIE_SIDEPUS_RIGHTS_MANIFEST` names an operator-approved rights manifest. It refuses to substitute the small public export for the web archive.

## Command

```bash
bash foundry/archie-distill/run_archie_sidepus_organism.sh
```

The command is resumable. Re-run it after a deadline checkpoint.

## Claim boundary

An executable combination is not evidence that any mechanism is useful. Passing discovery requires correct history to outperform both reset and wrong history while retaining the base language shell. Passing the campaign additionally requires a new-seed replication. The result remains research-only and does not authorize admission, autonomy, or 2B scaling.
