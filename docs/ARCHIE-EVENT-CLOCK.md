# Archie Event Clock v0

This branch contains a small executable research prototype and a hard predecessor gate. It does not authorize training before the linked-state experiment produces verified positive evidence.

## Architecture

The default prototype has 23,516,741 parameters:

```text
raw UTF-8 bytes
  -> seven selective-SSM byte blocks
  -> learned boundary probability
  -> straight-through event decision
  -> recurrent slow-state cell
  -> byte + slow-state decoder
```

The byte clock updates every byte. The slow clock changes only when the learned event gate commits an update. The final position is forced to commit so every segment produces a terminal slow state.

## Objectives

The forward contract exposes ordinary next-byte loss, future prediction from slow state, event-state reconstruction, event-rate regularization, and a state-delta head for repository or environment labels.

## Hard gate

`verify_recurrence_receipt()` refuses execution unless a byte-bound receipt states:

```text
schema                archie-linked-state-verdict/v1
verdict               recurrence-supported
event_clock_unblocked true
promotion             research-only-not-admitted
seeds                  >= 2
heldout_sources        >= 4
```

A negative, undersized, malformed, or promotion-crossing receipt stops the lane. The accepted receipt SHA-256 is bound into the Event Clock preflight.

## Validation

```bash
cd foundry/archie-distill
python -m unittest -v test_archie_event_clock.py
```

Four local tests pass for the 20–30M parameter bound, two-clock forward/loss contract, gradient flow through the event gate, negative-receipt refusal, and positive-receipt digest binding.

## Claim boundary

The architecture exists and can be tested mechanically. No Event Clock training has run, no causal event representation has been demonstrated, and no novelty or admission claim is permitted. The fixed experiment contract is in `maker/evaluations/archie-event-clock-v0.json`.
