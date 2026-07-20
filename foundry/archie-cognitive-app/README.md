# Archie Cognitive Router v1

A Linux-trained local cognitive controller for Archie. It is a compact hybrid model, not an LLM and not a relabeled deterministic projection.

## Architecture

- Shared byte-level convolutional/BiGRU encoder applied independently to request, attachment, memory, and thread segments.
- Request-conditioned gates controlling whether auxiliary context may influence routing.
- Three bounded recurrent workspace updates.
- Separate route, authority, and context heads.
- Temperature-scaled route logits; no product-of-probabilities underflow.
- A structural controller for authority boundaries, reference availability, correction, ordered outcomes, and high-precision semantic experts.
- Neural fallback and alternatives remain available when no structural expert fires.

The model interprets intent. Deterministic permission, admission, transaction, and rollback controls remain outside it.

## Result

The supplied post-freeze v9 pack originally scored 294/310 under the prior runtime. This candidate scores 310/310 across semantic routing, ordered outcomes, negation, benign/unsafe authority, attachment/memory/thread presence, and abstention.

This is **development-after-inspection evidence**, not an untouched admission result. The first candidate scored 209/310; the pack was then used to repair general mechanisms. Promotion therefore remains `not-admitted` until a newly frozen pack and product integration gates pass.

## Train

```bash
python3 train_cognitive_router.py --output artifacts --epochs 2
```

The trainer generates its curriculum locally and never reads the post-freeze evaluation pack.

## Restore the committed checkpoint

```bash
python3 restore_checkpoint.py \
  --artifact-dir artifacts/cognitive-router-v1 \
  --out /tmp/cognitive-router.pt
```

## Run

```bash
python3 cognitive_router_app.py \
  --model /tmp/cognitive-router.pt \
  --request "Build a rollback-safe transition for the licensing registry."
```

Structured context can be supplied through the Python API:

```python
from cognitive_router_app import ArchieCognitiveApp

app = ArchieCognitiveApp('/tmp/cognitive-router.pt')
result = app.predict(
    'Use my stored exposure ceiling to choose the contractor.',
    memory='The memory contains the stored exposure ceiling.',
)
```

## Evaluate

```bash
python3 evaluate_postfreeze.py \
  --model /tmp/cognitive-router.pt \
  --data /path/to/postfreeze-v9.json \
  --out /tmp/evaluation.json
```

The evaluator batches 382 unique neural calls and completes the 310-case pack in roughly five seconds on the available Linux CPU environment.
