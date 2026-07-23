# Archie linked-state experiment

This lane tests whether the existing scratch byte LM has useful recurrent state across source-contiguous segments. It does not create a new admitted model.

## Implemented boundary

`archie_linked_state.py` reuses the exact baseline model parameters and adds:

- persistent recurrent state and causal-convolution history for every selective-SSM block;
- local-attention KV caching with exact window truncation;
- per-example document reset masks and reset positional state;
- token-incremental generation without recomputing the retained context;
- state detachment for declared truncated-backpropagation boundaries.

`linked_state_controls.py` provides exact copies, resets, cross-document transplants, deterministic channel shuffles, state digests, and a fail-closed verdict.

## Required empirical campaign

The first real campaign must use fixed held-out sources and at least two seeds. For every later segment it must compare:

- A: correct carried state;
- B: reset state;
- C: state transplanted from another document;
- D: deterministically shuffled state channels.

Event Clock remains blocked unless A has lower bits per byte than B, C and D are measurably worse than A, incremental/full logits agree within `2e-5`, and ordinary fixed-manifest retention degrades by no more than `0.02` bits per byte.

## Local contract validation

```bash
cd foundry/archie-distill
python -m unittest -v test_archie_linked_state.py test_linked_state_controls.py
```

The additive implementation was locally exercised against an equivalent micro baseline: ten tests passed for full/incremental parity, split-state continuation, document reset isolation, detached state, deterministic state controls, and the evidence gate.

## Claim boundary

Passing contracts proves execution mechanics only. It does not prove that the 114M checkpoint learned useful long-range state. Training and held-out matched-control evidence remain required. Promotion remains `research-only-not-admitted`.
