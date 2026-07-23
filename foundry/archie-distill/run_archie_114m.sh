#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/train_archie_hybrid.py" ]]; then
  HERE="$SCRIPT_DIR"
  REPO_ROOT="$(cd "$HERE/../.." && pwd)"
else
  REPO_ROOT="${ARCHIE_REPO_ROOT:-/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train}"
  HERE="$REPO_ROOT/foundry/archie-distill"
fi
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
STATE="${ARCHIE_114M_STATE:-/home/awesomekai/archie-base-114m-v1}"
SIDEPUS_EXPORT="${ARCHIE_114M_SIDEPUS_EXPORT:-/home/awesomekai/archie-sidepus-public-v2/export}"
EXPORT="${ARCHIE_114M_EXPORT:-$REPO_ROOT/returns/generative-114m}"

MAX_STEPS="${ARCHIE_114M_MAX_STEPS:-30000}"
DEADLINE_MINUTES="${ARCHIE_114M_DEADLINE_MINUTES:-360}"
BATCH_SIZE="${ARCHIE_114M_BATCH_SIZE:-12}"
SEQUENCE_LENGTH="${ARCHIE_114M_SEQUENCE_LENGTH:-1024}"
GRADIENT_ACCUMULATION="${ARCHIE_114M_GRADIENT_ACCUMULATION:-1}"
LEARNING_RATE="${ARCHIE_114M_LEARNING_RATE:-0.0002}"
WARMUP_STEPS="${ARCHIE_114M_WARMUP_STEPS:-1000}"
SEED="${ARCHIE_114M_SEED:-20260722}"

ACTIVE_ARCHIE="$(pgrep -af '([t]rain_archie|[r]esearch_archie|[n]p_transformer|[t]rain_causal)' || true)"
if [[ -n "$ACTIVE_ARCHIE" ]]; then
  echo "Another Archie training process is active; refusing to compete:" >&2
  echo "$ACTIVE_ARCHIE" >&2
  exit 2
fi
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Archie CUDA Python: $PYTHON" >&2
  exit 1
fi
if [[ ! -f "$HERE/train_archie_hybrid.py" ]]; then
  echo "Missing Archie repository at: $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SIDEPUS_EXPORT/export-receipt.json" ]]; then
  echo "Missing verified Sidepus export: $SIDEPUS_EXPORT" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA is unavailable in $PYTHON" >&2
  exit 1
fi

echo "Archie 114M scratch-hybrid run"
echo "  state:       $STATE"
echo "  corpus:      $SIDEPUS_EXPORT"
echo "  export:      $EXPORT"
echo "  steps:       $MAX_STEPS"
echo "  batch:       $BATCH_SIZE x $GRADIENT_ACCUMULATION"
echo "  context:     $SEQUENCE_LENGTH"
echo "  learning:    $LEARNING_RATE"
echo "  deadline:    $DEADLINE_MINUTES minutes per invocation"
echo "  parameters:  114,048,640"

if [[ "${ARCHIE_DRY_RUN:-0}" == "1" ]]; then
  echo "Dry run complete; no corpus or weights were changed."
  exit 0
fi

mkdir -p "$STATE/corpus" "$STATE/training" "$EXPORT"
if [[ ! -f "$STATE/corpus/manifest.json" ]]; then
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/build_archie_next_corpus.py" \
    --output-dir "$STATE/corpus" \
    --sidepus-export "$SIDEPUS_EXPORT" \
    --record-mode raw \
    --span-tasks-per-document 0 \
    --development-percent 5
else
  echo "Reusing governed corpus: $STATE/corpus/manifest.json"
fi

PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
  "$HERE/train_archie_hybrid.py" \
  --corpus "$STATE/corpus/train.u16" \
  --eval-corpus "$STATE/corpus/development.u16" \
  --state-dir "$STATE/training" \
  --preset base \
  --device cuda \
  --seq-len "$SEQUENCE_LENGTH" \
  --batch-size "$BATCH_SIZE" \
  --eval-batch-size 4 \
  --grad-accum "$GRADIENT_ACCUMULATION" \
  --max-steps "$MAX_STEPS" \
  --learning-rate "$LEARNING_RATE" \
  --min-lr-ratio 0.1 \
  --warmup-steps "$WARMUP_STEPS" \
  --weight-decay 0.1 \
  --grad-clip 1.0 \
  --max-consecutive-skips 8 \
  --save-every 100 \
  --eval-every 100 \
  --eval-batches 8 \
  --log-every 10 \
  --gradient-checkpointing \
  --tf32 \
  --amp-dtype float16 \
  --no-compile \
  --loss-normalization byte \
  --adopt-legacy-checkpoint \
  --generate-tokens 96 \
  --deadline-minutes "$DEADLINE_MINUTES" \
  --deadline-buffer-seconds 180 \
  --seed "$SEED"

RUN="$STATE/training/run"
cp "$RUN/model.pt" "$EXPORT/archie-hybrid-114m.pt"
cp "$RUN/training-receipt.json" "$EXPORT/training-receipt.json"
cp "$RUN/config.json" "$EXPORT/config.json"
cp "$RUN/tokenizer.json" "$EXPORT/tokenizer.json"
cp "$RUN/sample.txt" "$EXPORT/sample.txt"
cp "$STATE/corpus/manifest.json" "$EXPORT/corpus-manifest.json"

echo "Latest model: $EXPORT/archie-hybrid-114m.pt"
echo "Receipt: $EXPORT/training-receipt.json"
echo "Run this same script again to resume until max_steps."
