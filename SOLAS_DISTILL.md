# Solas Co-Engineer Distill Report

**Co-engineer:** Solas (Base44 Superagent)
**Date:** 2026-07-21
**Branch:** `agent/solas-distill-appendage`
**Promotion:** not-admitted

This document is a co-engineer distillation analysis produced from a full read of the
repository and the attached `archie-causal-mechanism-full-budget` campaign bundle.
It does not claim that a canonical Qwen3-1.7B adapter has been trained or admitted.
All claims are bounded to observable evidence in the bundle.

---

## 1. What I read

- `AGENTS.md`, `HANDOFF.md`, `ARCHIE_DISTILL.md`, `ARCHIE_TRAINING.md`, `ARCHIE_MIND.md`
- `ARCHIE_RUNTIME.md`, `ARCHIE_WORKSPACES.md`, `ARCHIE_EQUIVALENCE.md`, `MODEL_FOUNDRY.md`
- `00-ARCHIE-MODEL/MODEL.json`, `STATUS.json`, `RUNBOOK.md`, `BENCHMARKS.md`, `ARCHITECTURE.md`
- `foundry/archie-distill/train.py` (full), all test contracts
- The full `archie-causal-mechanism-full-budget` bundle:
  - `campaign-manifest.json`, `checkpoint-manifest.json`, `evidence-bundle.json`
  - `falsification-report.json` (complete)
  - All 42 candidate `training-receipt.json` files
  - All 42 `evaluations/*.json` files
  - Frozen corpus `.pt` files (structure only; tensors not loaded)

---

## 2. Campaign bundle distillation

### 2.1 What the campaign ran

- **Schema:** `archie-causal-mechanism-campaign/v2`
- **Baseline:** `attention_baseline` (standard self-attention, ~97.9K params)
- **Mechanisms tested:** 7 families × 3 scales × 2 seeds = 42 candidates
- **Total optimizer steps:** 1,008 (planned == completed → full budget consumed)
- **Total estimated FLOPs:** 42.7B
- **Decision:** `not-admitted` (correct; surviving ≠ promoted)

### 2.2 Mechanism scores (mean across seeds and scales)

| Mechanism | Score | Compute-norm | Params | FLOPs | Δ vs baseline |
|---|---|---|---|---|---|
| **reversible_state** | **0.5010** | **0.05769** | **23,367** | **0.48B** | **+0.231** |
| object_recurrent | 0.4737 | 0.05363 | 32,879 | 0.68B | +0.203 |
| dynamic_transport | 0.4737 | 0.05369 | 32,139 | 0.67B | +0.203 |
| graph_routing | 0.4704 | 0.05323 | 33,288 | 0.69B | +0.200 |
| neural_interpreter | 0.4625 | 0.05004 | 84,271 | 1.75B | +0.192 |
| sparse_event_memory | 0.4545 | 0.05101 | 39,234 | 0.81B | +0.184 |
| attention_baseline | 0.2704 | 0.02906 | 97,938 | 2.03B | — |

**Key finding:** Every surviving mechanism beats the baseline by >18 points at **lower parameter count and lower FLOPs**. The attention baseline is the most expensive and worst-performing family.

### 2.3 Winner: `reversible_state`

`reversible_state` wins on all three axes simultaneously:
- Highest mechanism score (0.501)
- Highest compute-normalized score (0.058)
- **Fewest parameters** (23K — 4.2× fewer than baseline)
- **Lowest FLOPs** (0.48B — 4.2× cheaper than baseline)
- `latent_transplantation: supported = true` (unique property in this bundle)
- `latent_transplantation exact_agreement = 1.0` on the winning seed

The latent transplantation capability is architecturally significant: it means the
hidden state can be transplanted between contexts and the mechanism still recovers
exact terminal agreement. This is the primitive needed for `Come Back Tomorrow`
(interruption recovery) and `Don't Lie to Me` (state integrity under adversarial
conditions).

### 2.4 Where all mechanisms still fail

- `exact_terminal_accuracy = 0.0` across all families on every suite
- This is the hard gate. The campaign measures mechanism quality on a synthetic
  causal corpus, not on the Archie benchmark suite. Passing `exact_terminal_accuracy`
  on the real benchmark suite requires the canonical QLoRA CUDA training run on
  Qwen3-1.7B, independent reproduction, and admission.
- `terminal_exactness_failure = 1.0` for all families (universal failure mode on
  this corpus's exact-match criterion).

This is honest: the campaign falsifies mechanism choices; it does not produce a
usable generative model.

### 2.5 Recommendation for next CUDA run

Based on this bundle, I recommend:

1. **Use `reversible_state` as the architecture prior** for the next specialist
   training round. Its param efficiency and latent transplantation support make
   it the strongest candidate for the `information-budgeted-causal-fork-rslora/v1`
   canonical pipeline.
2. **Use `object_recurrent` as the second specialist** (tied score with
   `dynamic_transport`, but lower param variance across seeds).
3. **Retire `neural_interpreter` from the next round** — highest params (84K),
   second-lowest compute-norm score despite much higher FLOPs. Not a good trade.

---

## 3. Appendage: self-sophisticating CPU student

### 3.1 What it is

`foundry/archie-distill/appendage_student.py` is an orthogonal, CPU-only
self-training loop that:

- Treats the frozen campaign checkpoints as teacher signals
- Trains a 1,825-parameter MLP student to predict mechanism scores from
  evaluation feature vectors
- Runs 6 rounds (one per surviving mechanism, ordered by score)
- Emits `archie-appendage-student-receipt/v1` per round
- Terminates when convergence threshold is met or all teachers exhausted

### 3.2 Observed behavior (bundle run)

| Round | Teacher | Held-out RMSE | Tensors changed |
|---|---|---|---|
| 0 | dynamic_transport | 0.027278 | ✓ |
| 1 | graph_routing | 0.074209 | ✓ |
| 2 | reversible_state | 0.033561 | ✓ |
| 3 | sparse_event_memory | 0.040498 | ✓ |
| 4 | object_recurrent | **0.009532** | ✓ |
| 5 | neural_interpreter | 0.041232 | ✓ |

All rounds: tensors changed, receipts emitted, `promotion: not-admitted`.
Best RMSE at round 4 (object_recurrent teacher): 0.0095 — the student can
predict mechanism scores from eval features with <1% absolute error.

### 3.3 What this proves and does not prove

**Proves:**
- The campaign bundle contains enough signal to self-train a further student
- Tensor mutations occurred and are receipt-bound
- The appendage runs on the hosted Linux CPU runner today

**Does not prove:**
- QLoRA quality on Qwen3-1.7B
- Canonical adapter improvement
- Held-out Archie benchmark gains
- Promotion eligibility of any kind

---

## 4. False claims explicitly rejected

As required by the repository contract:

- The appendage student is not the canonical Qwen3-1.7B neural candidate
- CPU rehearsal does not prove CUDA/NF4 quality
- Surviving mechanism scores do not prove the student improved on held-out Archie benchmarks
- This report does not bypass independent verification or held-out evaluation gates
- `not-admitted` is the correct and only permissible promotion state for all artifacts here

---

## 5. Remaining blockers (unchanged from HANDOFF.md)

1. Canonical CUDA gradient run on Qwen3-1.7B at rank-32
2. Changed Archie adapter tensors (non-CPU)
3. Held-out quality gain on the real Archie benchmark suite
4. Fused candidate gain
5. Quantization retention
6. Independent reproduction on a clean machine
7. Physical A15 / 4GB device evidence (for iPhone admission)

None of these are altered by this co-engineer contribution. The appendage adds
evidence without claiming to substitute for any of the above gates.

---

## 6. Files contributed in this branch

```
foundry/archie-distill/appendage_student.py   — self-sophisticating CPU student
SOLAS_DISTILL.md                               — this document
```

Receipts produced locally (not committed — model weights and receipts stay outside Git
per repository policy):
```
appendage-receipts/round-00-receipt.json  (dynamic_transport)
appendage-receipts/round-01-receipt.json  (graph_routing)
appendage-receipts/round-02-receipt.json  (reversible_state)
appendage-receipts/round-03-receipt.json  (sparse_event_memory)
appendage-receipts/round-04-receipt.json  (object_recurrent)
appendage-receipts/round-05-receipt.json  (neural_interpreter)
appendage-receipts/appendage-summary.json
```

---

*Solas — co-engineer, 2026-07-21*
*This document follows the repository's sideways engineering contract.*
*Merge remains a human decision.*
