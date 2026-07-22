#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
STATE="${ARCHIE_RESEARCH_STATE:-/home/awesomekai/archie-hybrid-research-v1}"
EXPORT_DIR="${ARCHIE_RESEARCH_EXPORT_DIR:-$REPO_ROOT/returns/hybrid-research}"
DEFAULT_PWA="/mnt/c/Users/AwesomeKai/Documents/New project/Archie-Admitted-PWA"

PRESET="${ARCHIE_RESEARCH_PRESET:-tiny}"
SEQUENCE_LENGTH="${ARCHIE_RESEARCH_SEQUENCE_LENGTH:-512}"
BATCH_SIZE="${ARCHIE_RESEARCH_BATCH_SIZE:-32}"
CANDIDATE_MINUTES="${ARCHIE_RESEARCH_CANDIDATE_MINUTES:-8}"
LEARNING_RATE="${ARCHIE_RESEARCH_LEARNING_RATE:-0.0003}"
PAIR_VOCAB_SIZE="${ARCHIE_RESEARCH_PAIR_VOCAB_SIZE:-512}"
SPAN_TASKS="${ARCHIE_RESEARCH_SPAN_TASKS:-3}"
SEED="${ARCHIE_RESEARCH_SEED:-20260724}"
REPLICATION_SEED="${ARCHIE_RESEARCH_REPLICATION_SEED:-20260725}"
MINIMUM_EFFECT="${ARCHIE_RESEARCH_MINIMUM_EFFECT:-0.03}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing CUDA Python environment: $PYTHON" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA is unavailable in $PYTHON" >&2
  exit 1
fi

SOURCES=("$REPO_ROOT")
if [[ -d "$DEFAULT_PWA" ]]; then
  SOURCES+=("$DEFAULT_PWA")
fi
for source in "$@"; do
  if [[ ! -e "$source" ]]; then
    echo "Extra source does not exist: $source" >&2
    exit 1
  fi
  SOURCES+=("$source")
done

echo "Archie falsifiable research campaign"
echo "  state:             $STATE"
echo "  preset:            $PRESET"
echo "  context / batch:   $SEQUENCE_LENGTH / $BATCH_SIZE"
echo "  minutes/candidate: $CANDIDATE_MINUTES"
echo "  discovery seed:    $SEED"
echo "  replication seed:  $REPLICATION_SEED"
echo "  minimum effect:    $MINIMUM_EFFECT"
echo "  sources:"
printf '    - %s\n' "${SOURCES[@]}"

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

mkdir -p "$STATE/corpora" "$EXPORT_DIR"
SOURCE_ARGUMENTS=()
for source in "${SOURCES[@]}"; do
  SOURCE_ARGUMENTS+=(--source "$source")
done

build_corpus() {
  local name="$1"
  shift
  local output="$STATE/corpora/$name"
  if [[ "${ARCHIE_REBUILD_CORPUS:-0}" == "1" || ! -f "$output/manifest.json" ]]; then
    PYTHONPATH="$HERE" "$PYTHON" "$HERE/build_archie_next_corpus.py" \
      --output-dir "$output" \
      --development-percent 5 \
      --span-tasks-per-document "$SPAN_TASKS" \
      "${SOURCE_ARGUMENTS[@]}" "$@"
  else
    echo "Reusing $name corpus: $output/manifest.json"
  fi
}

build_corpus governed-byte --record-mode governed --tokenizer byte
build_corpus raw-byte --record-mode raw --tokenizer byte --file-class all
build_corpus raw-code-byte --record-mode raw --tokenizer byte --file-class code
build_corpus governed-pairgram \
  --record-mode governed --tokenizer pairgram --pair-vocab-size "$PAIR_VOCAB_SIZE"

CAMPAIGN_ARGUMENTS=()
if [[ -n "${ARCHIE_RESEARCH_CAMPAIGN_JSON:-}" ]]; then
  CAMPAIGN_ARGUMENTS+=(--campaign-json "$ARCHIE_RESEARCH_CAMPAIGN_JSON")
fi
if [[ -n "${ARCHIE_PLASTIC_SUITE:-}" ]]; then
  CAMPAIGN_ARGUMENTS+=(--plastic-suite "$ARCHIE_PLASTIC_SUITE")
fi

PYTHONPATH="$HERE" "$PYTHON" "$HERE/research_archie_hybrid.py" \
  --state-dir "$STATE/campaign" \
  --governed-byte "$STATE/corpora/governed-byte" \
  --raw-byte "$STATE/corpora/raw-byte" \
  --raw-code-byte "$STATE/corpora/raw-code-byte" \
  --governed-pairgram "$STATE/corpora/governed-pairgram" \
  --python "$PYTHON" \
  --preset "$PRESET" \
  --device cuda \
  --sequence-length "$SEQUENCE_LENGTH" \
  --batch-size "$BATCH_SIZE" \
  --candidate-minutes "$CANDIDATE_MINUTES" \
  --learning-rate "$LEARNING_RATE" \
  --seed "$SEED" \
  --replication-seed "$REPLICATION_SEED" \
  --minimum-effect "$MINIMUM_EFFECT" \
  "${CAMPAIGN_ARGUMENTS[@]}"

cp "$STATE/campaign/campaign-receipt.json" "$EXPORT_DIR/campaign-receipt.json"
if [[ -d "$STATE/campaign/selected" ]]; then
  cp -f "$STATE/campaign/selected/"* "$EXPORT_DIR/"
  echo "Selected pilot: $EXPORT_DIR/model.pt"
else
  echo "No stable pilot was selected; inspect the campaign receipt." >&2
fi

echo "Campaign receipt: $EXPORT_DIR/campaign-receipt.json"
echo "Rerunning reuses completed candidates and resumes interrupted ones."
