# Archie Distill Core

This repository has one job: turn authorized teacher outputs into the smallest useful supervision set, train local student adapters, evaluate them on a frozen reference holdout, and select the best measured candidate.

Everything else was removed. There is no consumer UI, social layer, mobile shell, product demo, founder room, general agent runtime, remote shell, synthetic progress surface, or admission theater.

## The only pipeline

1. **Collect** compact final answers from OpenAI-compatible teacher endpoints.
2. **Delete reasoning** before persistence. `<think>`, analysis, rationale, scratchpad, and chain-of-thought fields are stripped; raw teacher responses are not stored.
3. **Spend teacher tokens adaptively.** The cheapest/highest-priority teacher runs first. Extra teachers run only for configured verification, low confidence, failure, or unresolved disagreement.
4. **Train** a pinned local student with CUDA-only 4-bit NF4 QLoRA. CPU fallback and non-LoRA parameter updates are refused.
5. **Evaluate** against a frozen holdout with deterministic decoding and reference-based metrics.
6. **Select** the highest-scoring adapter, breaking ties in favor of fewer generated evaluation tokens.

Use only teacher endpoints and outputs you are authorized to use for distillation.

## Linux setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
```

Collection uses only the Python standard library. GPU training and evaluation additionally require:

```bash
python -m pip install -r requirements-train.txt
```

The model checkpoint must already exist locally. Training and evaluation set Hugging Face libraries to offline mode and never download weights.

## Inputs

`prompts.jsonl`:

```json
{"id":"math-1","prompt":"What is 17 * 19?","reference":"323","split":"train","verify":true}
{"id":"format-1","messages":[{"role":"user","content":"Return the ISO date after 2026-07-21."}],"split":"train"}
```

`holdout.jsonl` must contain `reference` or `references` for every row:

```json
{"id":"heldout-1","prompt":"What is 23 * 29?","reference":"667"}
```

Teacher services must expose an OpenAI-compatible `POST /v1/chat/completions` endpoint. `config.example.json` works with local llama.cpp-compatible servers after changing model names and URLs.

## Run

```bash
python -m archie_distill collect \
  --config config.json \
  --prompts prompts.jsonl \
  --output runs/collection-001

python -m archie_distill train \
  --config config.json \
  --dataset runs/collection-001/dataset.jsonl \
  --model /models/student-base \
  --output runs/candidate-001

python -m archie_distill evaluate \
  --config config.json \
  --holdout holdout.jsonl \
  --model /models/student-base \
  --adapter runs/candidate-001/adapter \
  --output runs/candidate-001/evaluation-receipt.json

python -m archie_distill select \
  --receipts runs/candidate-*/evaluation-receipt.json \
  --minimum-score 0.80 \
  --output runs/best.json
```

Every stage writes a digest-bound receipt. Selection does not claim model admission or production readiness.
