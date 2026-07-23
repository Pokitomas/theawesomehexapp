#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
STATE="${ARCHIE_STATE:-/home/awesomekai/archie-generative-v3}"
BASE_MODEL="${ARCHIE_BASE_MODEL:-$REPO_ROOT/returns/generative-final/archie-hybrid-generative.pt}"
EXPORT_DIR="${ARCHIE_EXPORT_DIR:-$REPO_ROOT/returns/generative-next}"
DEFAULT_PWA="/mnt/c/Users/AwesomeKai/Documents/New project/Archie-Admitted-PWA"
CURRICULUM_EXCHANGE="${ARCHIE_CURRICULUM_EXCHANGE:-}"

MAX_STEPS="${ARCHIE_MAX_STEPS:-1500}"
DEADLINE_MINUTES="${ARCHIE_DEADLINE_MINUTES:-180}"
PLASTIC_MODE="${ARCHIE_PLASTIC_MODE:-none}"
PLASTIC_RANK="${ARCHIE_PLASTIC_RANK:-16}"
if [[ -n "${ARCHIE_BATCH_SIZE:-}" ]]; then
  BATCH_SIZE="$ARCHIE_BATCH_SIZE"
elif [[ "$PLASTIC_MODE" == "delta" ]]; then
  BATCH_SIZE=8
else
  BATCH_SIZE=32
fi
SEQUENCE_LENGTH="${ARCHIE_SEQUENCE_LENGTH:-1024}"
LEARNING_RATE="${ARCHIE_LEARNING_RATE:-0.00006}"
WARMUP_STEPS="${ARCHIE_WARMUP_STEPS:-50}"
SIDEPUS_EXPORTS=()
if [[ -n "${ARCHIE_SIDEPUS_EXPORTS:-}" ]]; then
  IFS=':' read -r -a SIDEPUS_EXPORTS <<< "$ARCHIE_SIDEPUS_EXPORTS"
fi
if [[ ${#SIDEPUS_EXPORTS[@]} -gt 0 ]]; then
  SPAN_TASKS="${ARCHIE_SPAN_TASKS:-0}"
  RECORD_MODE="${ARCHIE_RECORD_MODE:-raw}"
else
  SPAN_TASKS="${ARCHIE_SPAN_TASKS:-3}"
  RECORD_MODE="${ARCHIE_RECORD_MODE:-governed}"
fi
DEVELOPMENT_PERCENT="${ARCHIE_DEVELOPMENT_PERCENT:-5}"
SEED="${ARCHIE_SEED:-20260723}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing CUDA Python environment: $PYTHON" >&2
  exit 1
fi
if [[ ! -f "$BASE_MODEL" ]]; then
  echo "Missing base Archie model: $BASE_MODEL" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA is unavailable in $PYTHON" >&2
  exit 1
fi

SOURCES=()
if [[ "${ARCHIE_INCLUDE_LOCAL_SOURCES:-1}" == "1" ]]; then
  SOURCES+=("$REPO_ROOT")
  if [[ -d "$DEFAULT_PWA" ]]; then
    SOURCES+=("$DEFAULT_PWA")
  fi
fi
for source in "$@"; do
  if [[ ! -e "$source" ]]; then
    echo "Extra source does not exist: $source" >&2
    exit 1
  fi
  SOURCES+=("$source")
done
for export in "${SIDEPUS_EXPORTS[@]}"; do
  if [[ ! -d "$export" ]]; then
    echo "Sidepus export does not exist: $export" >&2
    exit 1
  fi
done
if [[ ${#SOURCES[@]} -eq 0 && ${#SIDEPUS_EXPORTS[@]} -eq 0 ]]; then
  echo "No local sources or Sidepus exports were configured." >&2
  exit 1
fi

echo "Archie next-stage configuration"
echo "  state:       $STATE"
echo "  base model:  $BASE_MODEL"
echo "  export:      $EXPORT_DIR"
echo "  steps:       $MAX_STEPS"
echo "  batch:       $BATCH_SIZE"
echo "  context:     $SEQUENCE_LENGTH"
echo "  learning:    $LEARNING_RATE"
echo "  plasticity:  $PLASTIC_MODE (rank $PLASTIC_RANK)"
echo "  curriculum:  ${CURRICULUM_EXCHANGE:-uniform governed replay}"
echo "  records:     $RECORD_MODE (span tasks $SPAN_TASKS)"
echo "  deadline:    $DEADLINE_MINUTES minutes"
echo "  sources:"
if [[ ${#SOURCES[@]} -gt 0 ]]; then
  printf '    - %s\n' "${SOURCES[@]}"
else
  echo "    - none (Sidepus-only diet)"
fi
if [[ ${#SIDEPUS_EXPORTS[@]} -gt 0 ]]; then
  echo "  Sidepus exports:"
  printf '    - %s\n' "${SIDEPUS_EXPORTS[@]}"
fi

if [[ "${ARCHIE_DRY_RUN:-0}" == "1" ]]; then
  echo "Dry run complete; no corpus or weights were changed."
  exit 0
fi

ACTIVE_ARCHIE_GPU="$(pgrep -af '([t]rain_archie_hybrid.py|[r]esearch_archie_hybrid.py|[c]alibrate_hybrid_vram.py)' || true)"
if [[ -n "$ACTIVE_ARCHIE_GPU" && "${ARCHIE_ALLOW_CONCURRENT_GPU:-0}" != "1" ]]; then
  echo "Another Archie GPU job is already active; refusing to compete for VRAM:" >&2
  echo "$ACTIVE_ARCHIE_GPU" >&2
  echo "Wait for it to finish, or set ARCHIE_ALLOW_CONCURRENT_GPU=1 deliberately." >&2
  exit 1
fi

mkdir -p "$STATE/corpus" "$STATE/training" "$EXPORT_DIR"
CORPUS_ARGUMENTS=()
for source in "${SOURCES[@]}"; do
  CORPUS_ARGUMENTS+=(--source "$source")
done
for export in "${SIDEPUS_EXPORTS[@]}"; do
  CORPUS_ARGUMENTS+=(--sidepus-export "$export")
done
if [[ -n "${ARCHIE_MAX_TRAIN_TOKENS:-}" ]]; then
  CORPUS_ARGUMENTS+=(--max-train-tokens "$ARCHIE_MAX_TRAIN_TOKENS")
fi
if [[ -n "${ARCHIE_MAX_DEVELOPMENT_TOKENS:-}" ]]; then
  CORPUS_ARGUMENTS+=(--max-development-tokens "$ARCHIE_MAX_DEVELOPMENT_TOKENS")
fi
if [[ -n "$CURRICULUM_EXCHANGE" ]]; then
  if [[ ! -f "$CURRICULUM_EXCHANGE" ]]; then
    echo "Missing curriculum exchange: $CURRICULUM_EXCHANGE" >&2
    exit 1
  fi
  CORPUS_ARGUMENTS+=(--curriculum-exchange "$CURRICULUM_EXCHANGE")
fi

if [[ "${ARCHIE_REBUILD_CORPUS:-0}" == "1" || ! -f "$STATE/corpus/manifest.json" ]]; then
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/build_archie_next_corpus.py" \
    --output-dir "$STATE/corpus" \
    --development-percent "$DEVELOPMENT_PERCENT" \
    --span-tasks-per-document "$SPAN_TASKS" \
    --record-mode "$RECORD_MODE" \
    "${CORPUS_ARGUMENTS[@]}"
else
  echo "Reusing governed corpus: $STATE/corpus/manifest.json"
fi

PLASTIC_ARGUMENTS=(--plastic-mode "$PLASTIC_MODE" --plastic-rank "$PLASTIC_RANK")
if [[ "$PLASTIC_MODE" == "delta" ]]; then
  PLASTIC_ARGUMENTS+=(--allow-plastic-upgrade)
fi

PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
  "$HERE/train_archie_hybrid.py" \
  --corpus "$STATE/corpus/train.u16" \
  --eval-corpus "$STATE/corpus/development.u16" \
  --init-model "$BASE_MODEL" \
  --state-dir "$STATE/training" \
  --preset small \
  --device cuda \
  --seq-len "$SEQUENCE_LENGTH" \
  --batch-size "$BATCH_SIZE" \
  --eval-batch-size 8 \
  --grad-accum 1 \
  --max-steps "$MAX_STEPS" \
  --learning-rate "$LEARNING_RATE" \
  --min-lr-ratio 0.1 \
  --warmup-steps "$WARMUP_STEPS" \
  --weight-decay 0.1 \
  --grad-clip 1.0 \
  --max-consecutive-skips 8 \
  --save-every 50 \
  --eval-every 50 \
  --eval-batches 8 \
  --log-every 10 \
  --generate-tokens 64 \
  --deadline-minutes "$DEADLINE_MINUTES" \
  --deadline-buffer-seconds 120 \
  --seed "$SEED" \
  --amp-dtype float16 \
  "${PLASTIC_ARGUMENTS[@]}"

RUN="$STATE/training/run"
cp "$RUN/model.pt" "$EXPORT_DIR/archie-hybrid-generative-next.pt"
cp "$RUN/training-receipt.json" "$EXPORT_DIR/training-receipt.json"
cp "$RUN/config.json" "$EXPORT_DIR/config.json"
cp "$RUN/tokenizer.json" "$EXPORT_DIR/tokenizer.json"
cp "$RUN/sample.txt" "$EXPORT_DIR/sample.txt"
cp "$STATE/corpus/manifest.json" "$EXPORT_DIR/corpus-manifest.json"
if [[ -n "$CURRICULUM_EXCHANGE" ]]; then
  cp "$CURRICULUM_EXCHANGE" "$EXPORT_DIR/curriculum-exchange.json"
fi

echo "Archie next-stage model: $EXPORT_DIR/archie-hybrid-generative-next.pt"
echo "Receipt: $EXPORT_DIR/training-receipt.json"
echo "Resume by running this exact command again."
