# Archie Generative Reasoner

This directory contains the completed research lane reserved by PR #678. It trains a real
encoder-decoder student above the existing twelve-route classifier. The student emits two
machine-readable objects:

1. a compact supervised task graph; and
2. a grounded response plan with a `response_action`.

It does **not** generate final user prose, execute tools, upload attachments, download a
foundation model, or replace any admitted product artifact. Every output remains
`promotion: not-admitted` until a separately frozen admission pack proves otherwise.

## What was recovered

The interrupted run stopped after creating only `LEASE.md` and before writing or starting the
training program. This implementation completes the plan visible in that run:

- training-only SentencePiece vocabulary with `<REQUEST>`, `<ATTACHMENT>`, `<MEMORY>`,
  `<THREAD>`, graph, plan, and clarify symbols;
- bidirectional GRU encoder with an attention-conditioned recurrent decoder, explicit source/target padding handling, and linear-time autoregressive decoding;
- auxiliary route, authority, context, and transform heads;
- AdamW, warmup plus cosine decay, gradient clipping, checkpoint/resume, AMP on CUDA, and
  deterministic seeds;
- `diagnostic`, `small`, `full`, and `large` candidates;
- candidate sweeps over architectures and seeds;
- word + character TF-IDF LogisticRegression baseline;
- development temperature scaling for route probabilities;
- exact frozen-prompt removal before both tokenizer training and weight training;
- evaluation on the three audit route suites and reconstructed suite-80;
- fail-closed postprocessing: denied authority, missing/ambiguous context, or malformed
  generation always becomes `clarify`;
- digest-bound checkpoint, tokenizer, data, baseline, and run receipts.

## Model target

A normal supervised target has this shape:

```text
<TASK_GRAPH>{"authority":"allow","context":"ready","nodes":[...],"route":"summary","transform":"direct"}</TASK_GRAPH>
<PLAN>{"grounding":["request","attachment:0"],"must_clarify":false,"response_action":"summarize"}</PLAN>
```

Authority is a two-class learned label: `allow` or `deny`. Clarification is represented as
authority `allow` with context `missing` or `ambiguous`, unless authority is explicitly denied.
The final gate does not trust free generation alone; auxiliary denial/missing predictions and
invalid JSON force the canonical clarify graph.

## Install

Python 3.10 or newer is required.

```bash
python3 -m venv .venv-archie-reasoner
. .venv-archie-reasoner/bin/activate
python -m pip install -r foundry/archie-reasoner/requirements.txt
```

No runtime command makes network calls. Installation is the only step that may need package
access.

## External data preparation

The audit export and generated corpora stay outside Git:

```bash
mkdir -p .local/archie-audit .local/archie-route
unzip Archie-Audit.zip -d .local/archie-audit

node foundry/archie-protocol/prepare-route-data.mjs \
  --audit .local/archie-audit/files \
  --out .local/archie-route/route-train.json \
  --freeze-suite .local/archie-route/suite-80.json

node foundry/archie-protocol/mega-distill-route-data.mjs \
  --input .local/archie-route/route-train.json \
  --out .local/archie-route/route-train.distilled.json \
  --copies 6
```

`train.py` accepts either JSON arrays or JSONL. A record needs a request field
(`prompt`, `text`, `request`, or `input`) and a route field (`route`, `expected`, or `label`).
Optional fields include:

```json
{
  "attachments": [{"name": "notes.txt"}],
  "memory": "Jennifer asked for concise follow-up language",
  "thread": true,
  "authority": "allow",
  "context_state": "ready",
  "transform_type": "continue",
  "missing_fields": []
}
```

## Run the sparse lexical baseline

```bash
python foundry/archie-reasoner/baseline.py \
  --data .local/archie-route/route-train.distilled.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --output .local/archie-reasoner/baseline
```

The baseline uses up to 16,000 combined word and character TF-IDF features with multinomial
LogisticRegression. It predicts route, authority, context, and transform labels but cannot emit
a graph or plan.

## Run the two-epoch diagnostic

```bash
python foundry/archie-reasoner/train.py \
  --data .local/archie-route/route-train.distilled.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --output .local/archie-reasoner/diagnostic \
  --preset diagnostic
```

The diagnostic preset is intentionally small: 128 hidden width, two encoder and two decoder
layers, 3× feed-forward expansion, batch 128, and two epochs. It exists to catch schema,
tokenizer, masking, checkpoint, and evaluation defects before full training.

## Run the full candidate

```bash
python foundry/archie-reasoner/train.py \
  --data .local/archie-route/route-train.distilled.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --output .local/archie-reasoner/full \
  --preset full
```

The full preset uses:

- 8,192 SentencePiece tokens;
- width 256;
- four bidirectional-GRU encoder layers and four recurrent decoder layers;
- 3× feed-forward expansion;
- AdamW at `3e-4`;
- eight epochs;
- batch size 48;
- warmup plus cosine decay;
- generation, route, authority, context, and transform losses.

Use `--resume` to continue from `last.pt`.

## Compare candidate sizes and seeds

```bash
python foundry/archie-reasoner/train.py \
  --data .local/archie-route/route-train.distilled.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --output .local/archie-reasoner/sweep \
  --sweep diagnostic,small,full,large \
  --seeds 3407,20260720
```

Each candidate gets an isolated tokenizer, checkpoint, metrics history, and receipt.
`sweep-receipt.json` ranks candidates only on the internal development split. Frozen suites are
reporting evidence, not hyperparameter selectors.

## Run one inference

```bash
printf '%s' 'Summarize the attached notes and draft a follow-up.' | \
python foundry/archie-reasoner/infer.py \
  --bundle .local/archie-reasoner/full \
  --attachment notes.txt \
  --memory 'Use a confident but concise tone'
```

The output includes raw generation, calibrated auxiliary predictions, and the final guarded
graph/plan. Attachment names are metadata signals only unless attachment contents were
explicitly put in the input corpus.

## Artifacts

A candidate directory contains:

```text
tokenizer.model
tokenizer.vocab
tokenizer.corpus.txt
last.pt
best.pt
history.json
receipt.json
```

The receipt binds the training-row digest, tokenizer SHA-256, checkpoint SHA-256, model
configuration, parameter count, temperature, development metrics, frozen-suite metrics, and
the claim boundary.

## Admission boundary

Do not copy `best.pt` into `archie/`, `archie-operator/`, an iOS bundle, or a release workflow.
This lane does not inherit admission from the existing local route classifier. Admission would
require a new untouched pack, exact artifact identity, fail-closed authority checks, graph
schema validity, response-action fidelity, and an explicit product/runtime integration review.
