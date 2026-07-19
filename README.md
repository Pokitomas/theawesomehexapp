# Archie Model

> **AI and human scanners: begin with [`00-ARCHIE-MODEL/`](./00-ARCHIE-MODEL/README.md).** It is the canonical model package and the first directory in a downloaded repository ZIP.

Archie is a trainable local-first model system for turning one vague unfinished human intention into a finished, verified digital reality. The current canonical candidate is:

```text
Qwen3-1.7B
+ information-budgeted causal-fork training
+ two rank-32 RSLoRA specialists
+ exact scale-aware fusion to rank 64
+ full-sequence frozen-base evaluation
```

The repository now treats that learned model candidate as the primary object. Founder, Maker, Foundry, runtimes, product surfaces, evaluation systems, and compatibility code exist around it.

## Current empirical truth

| Question | Answer |
|---|---|
| Is there an executable current training architecture? | Yes. |
| Is the base model pinned exactly? | Yes: `Qwen/Qwen3-1.7B` revision `8d4744f9e13072f4920c326350fa81eedb74eae9`. |
| Does the method train from verified failed→repair causal forks? | Yes. |
| Are RSLoRA specialist training, tensor proof, fusion, and held-out gates implemented? | Yes. |
| Does this repository currently prove an improved, independently reproduced Archie adapter? | No. |
| Is any neural candidate admitted or promoted? | No: `promotion: not-admitted`. |

Code readiness is not model capability. The live evidence ledger is [`00-ARCHIE-MODEL/STATUS.json`](./00-ARCHIE-MODEL/STATUS.json).

## What Archie is

**Archie is a Qwen3-based candidate trained to prefer the exact verified repair at the first causal divergence from a failed attempt, while the surrounding system proves that its actions changed reality rather than merely sounding persuasive.**

The canonical learning path is:

```text
failed attempt with evidence
→ independently verified repaired descendant
→ chosen/rejected causal pair
→ replay the minimum context needed to understand the fork
→ train two rank-32 RSLoRA specialists
→ prove adapter tensors changed
→ compare each specialist against the frozen base
→ fuse only non-regressive specialists with exact scale handling
→ evaluate the fused adapter on full sequences
→ test quantized retention
→ independently reproduce
→ admit or reject
```

See:

- [`00-ARCHIE-MODEL/MODEL.json`](./00-ARCHIE-MODEL/MODEL.json) for the machine-readable model card;
- [`00-ARCHIE-MODEL/ARCHITECTURE.md`](./00-ARCHIE-MODEL/ARCHITECTURE.md) for the method;
- [`00-ARCHIE-MODEL/BENCHMARKS.json`](./00-ARCHIE-MODEL/BENCHMARKS.json) for the benchmark registry;
- [`00-ARCHIE-MODEL/RUNBOOK.md`](./00-ARCHIE-MODEL/RUNBOOK.md) for exact execution order.

## How Archie is judged

Archie is not primarily judged by trivia, chat preference, or whether it writes impressive prose. It is judged by personally designed real-life completion benchmarks:

1. **One Box, Weird Dream** — one vague prompt becomes a polished installable product.
2. **Stranger's Repo** — diagnose and repair an unfamiliar repository without collateral damage.
3. **Learn the Exact Repair** — improve held-out causal repair decisions with a measured compute-quality gain.
4. **Come Back Tomorrow** — survive interruption without duplicating or inventing work.
5. **Don't Lie to Me** — never convert a blocker, rehearsal, or partial artifact into a false success claim.
6. **Laptop, Not Lab** — remain useful on ordinary bounded-memory CPU hardware after training.
7. **Still Archie After Quantization** — preserve admitted behavior in the deployable GGUF.

The full protocols and targets are in [`00-ARCHIE-MODEL/BENCHMARKS.md`](./00-ARCHIE-MODEL/BENCHMARKS.md).

## Canonical source map

| Model responsibility | Canonical path |
|---|---|
| Model profile | `maker/evaluations/archie-information-budgeted-rslora.json` |
| Failed→repair pair compiler | `foundry/archie-distill/compile_causal_pairs.py` |
| Segmentation, reference cache, and RSLoRA training | `foundry/archie-distill/information_budgeted_rslora.py` |
| Specialist changed-tensor and frozen-base verification | `foundry/archie-distill/verify_segment_adapter.py` |
| Exact scale-aware fusion | `foundry/archie-distill/fuse_information_budgeted_adapters.py` |
| Fused candidate evaluation | `foundry/archie-distill/evaluate_fused_adapter.py` |
| Canonical orchestration | `.github/workflows/archie-information-budgeted-rslora.yml` |
| Contract tests | `foundry/archie-distill/test_information_budgeted_rslora.py` |
| Method note | `docs/archie-information-budgeted-rslora.md` |

Older training lanes and sample applications do not supersede this map.

## Run the non-neural contracts

```bash
python -m py_compile \
  foundry/archie-distill/information_budgeted_rslora.py \
  foundry/archie-distill/fuse_information_budgeted_adapters.py \
  foundry/archie-distill/test_information_budgeted_rslora.py

python foundry/archie-distill/test_information_budgeted_rslora.py
npm run test:archie:distill
npm run test:authority
```

These commands prove the training machinery and boundaries. They do not produce an admitted model.

## Dispatch the canonical model run

After the required self-hosted CPU/data, CUDA, and fusion runner variables and exact local inputs are configured:

```bash
gh workflow run archie-information-budgeted-rslora.yml \
  --ref main \
  -f request_id="archie-ib-rslora-$(date -u +%Y%m%dT%H%M%SZ)" \
  -f round=0 \
  -f shards=2 \
  -f max_fused_rank=64
```

The workflow is fail-closed. Missing compute, model bytes, data, or configuration produces a blocker rather than a synthetic training receipt.

## The system around the model

```text
Founder → captures one unfinished human intention
Archie  → owns objective, reasoning, uncertainty, memory, and coordination
Maker   → executes permissioned effects and verifies reality changed
Foundry → trains, evaluates, reproduces, admits, or rejects models
```

### Public surfaces

- Founder: `https://pokitomas.github.io/theawesomehexapp/`
- Archie: `https://pokitomas.github.io/theawesomehexapp/archie/`
- Maker: `https://pokitomas.github.io/theawesomehexapp/maker/`
- Foundry: `https://pokitomas.github.io/theawesomehexapp/foundry/`
- Frontier World Expo: `https://pokitomas.github.io/theawesomehexapp/world-expo/`

These are product and research surfaces. They are not themselves the learned neural model.

## Source-package preview

```bash
npm install --global https://github.com/Pokitomas/theawesomehexapp/archive/refs/heads/main.tar.gz
archie
```

The source preview does not bundle an admitted model artifact.

## Repository layout rule

A scanner should classify the repository in this order:

```text
00-ARCHIE-MODEL/  canonical identity, architecture, status, benchmarks, runbook
foundry/          model training, evaluation, fusion, quantization, admission
maker/            permissioned execution, model profiles, and evaluation data
scripts/          runtime, memory, coordination, receipts, and product machinery
archie/ founder/  human-facing product surfaces
examples/         ordinary outputs and regression targets
other paths       authority, compatibility, infrastructure, or older experiments
```

The largest directory is not automatically the current model. [`00-ARCHIE-MODEL/MODEL.json`](./00-ARCHIE-MODEL/MODEL.json) is authoritative.

## First impossible proof

Give a non-developer one input box, an unfamiliar environment, and a bounded resource envelope. Let them state one vague ambitious intention. Return a polished, secure, tested, installable product that did not previously exist—with no manual Git or ticket workflow, clean-environment reproduction, clickable delivery, exact receipts, and honest uncertainty.

A persuasive answer is not completion. Changed reality is.