# Archie — canonical model package

This is the first directory an AI or human should inspect after downloading the repository ZIP.

Archie is a trainable local-first model system intended to turn one vague human intention into a finished, verified digital artifact. The current canonical candidate is **Qwen3-1.7B adapted with information-budgeted causal-fork RSLoRA**, then fused and evaluated under strict evidence gates.

## What this repository contains today

- A complete executable training method and workflow for the current candidate.
- Verified-repair data compilation, causal-fork replay, RSLoRA specialist training, scale-correct fusion, evaluation, quantization, and admission plumbing.
- Product, runtime, memory, tool-use, execution, and evidence systems around the model.
- **No independently admitted Archie adapter or merged checkpoint yet.** Code readiness is not model capability.

## Canonical identity

```text
base: Qwen/Qwen3-1.7B
revision: 8d4744f9e13072f4920c326350fa81eedb74eae9
method: information-budgeted-causal-fork-rslora/v1
training signal: verified failed trajectory → verified repaired descendant
specialists: two rank-32 RSLoRA adapters
fusion: exact scale-aware concatenation, maximum rank 64
final gate: full-sequence frozen-base comparison
promotion: not-admitted until empirical gates pass
```

## Scan order

1. [`MODEL.json`](./MODEL.json) — machine-readable identity, architecture, paths, and claim boundary.
2. [`STATUS.json`](./STATUS.json) — what has and has not been empirically demonstrated.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the model learns and why this is the canonical lane.
4. [`BENCHMARKS.json`](./BENCHMARKS.json) — machine-readable, personally designed Archie benchmarks.
5. [`BENCHMARKS.md`](./BENCHMARKS.md) — plain-language benchmark explanation.
6. [`RUNBOOK.md`](./RUNBOOK.md) — exact commands and evidence sequence.
7. [`SCAN_ORDER.txt`](./SCAN_ORDER.txt) — compact ingestion order for automated scanners.

## The one-sentence model definition

**Archie is a Qwen3-based model candidate trained to prefer the exact verified repair at the first causal divergence from a failed attempt, while the surrounding system proves that its actions changed reality rather than merely sounding persuasive.**

## The learning path

```text
failed attempt with evidence
  → independently verified repaired descendant
  → chosen/rejected causal pair
  → replay only the context needed to understand the fork
  → train two rank-32 RSLoRA specialists
  → prove adapter tensors changed
  → compare each specialist against the frozen base
  → fuse only non-regressive specialists with exact scale handling
  → evaluate the fused adapter on full sequences
  → test quantized retention
  → independently reproduce
  → admit or reject
```

## What counts as success

Archie is not judged primarily by academic trivia or chat preference. It is judged by whether an ordinary person can state a messy ambition once and receive a polished, secure, tested, installable result without becoming a project manager.

The core empirical bar is:

```text
lower measured compute than the established lane
AND no held-out regression
AND a strict quality gain
AND no false claim of completion
AND clean reproduction on another machine
```

See [`BENCHMARKS.md`](./BENCHMARKS.md) for the full non-academic suite.

## Canonical implementation paths

| Purpose | Path |
|---|---|
| Candidate profile | `maker/evaluations/archie-information-budgeted-rslora.json` |
| Pair compilation | `foundry/archie-distill/compile_causal_pairs.py` |
| Segmentation, cache, and training | `foundry/archie-distill/information_budgeted_rslora.py` |
| Adapter fusion | `foundry/archie-distill/fuse_information_budgeted_adapters.py` |
| Specialist verification | `foundry/archie-distill/verify_segment_adapter.py` |
| Fused evaluation | `foundry/archie-distill/evaluate_fused_adapter.py` |
| Canonical workflow | `.github/workflows/archie-information-budgeted-rslora.yml` |
| Dependency-light contract tests | `foundry/archie-distill/test_information_budgeted_rslora.py` |
| Detailed method note | `docs/archie-information-budgeted-rslora.md` |

## Repository interpretation rule

Everything outside this directory is one of four things:

1. implementation used by the canonical model;
2. product/runtime infrastructure that lets the model act;
3. evaluation, evidence, authority, or admission infrastructure;
4. compatibility material or an older experiment.

Older experiments do not outrank the candidate named in `MODEL.json`. A scanner should never infer that the largest or most numerous directory is the current model.

## Claim boundary

The repository may truthfully claim that the training architecture exists and its dependency-light contracts pass. It may not claim an improved Archie model until real gradient receipts, changed tensors, held-out gain, fused evaluation, quantization retention, and independent reproduction exist.