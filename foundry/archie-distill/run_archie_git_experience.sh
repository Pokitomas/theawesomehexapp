#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
DATA="${ARCHIE_GIT_EXPERIENCE_DATA:-$REPO_ROOT/returns/git-experience-v2/data}"
MODEL="${ARCHIE_GIT_EXPERIENCE_MODEL:-$REPO_ROOT/returns/generative-sidepus-public/archie-hybrid-generative-next.pt}"
STATE="${ARCHIE_GIT_EXPERIENCE_STATE:-/home/awesomekai/archie-git-experience-run}"
EXPORT="${ARCHIE_GIT_EXPERIENCE_EXPORT:-$REPO_ROOT/returns/generative-git-experience}"

for required in "$PYTHON" "$MODEL" "$DATA/git-experience.train.jsonl" "$DATA/git-experience.development.jsonl" "$DATA/git-experience-receipt.json"; do
  if [[ ! -e "$required" ]]; then
    echo "Missing required Archie experience artifact: $required" >&2
    exit 1
  fi
done
if pgrep -af '([t]rain_archie_git_experience.py|[t]rain_archie_hybrid.py|[r]esearch_archie_hybrid.py)' >/dev/null; then
  echo "Another Archie GPU training process is active." >&2
  exit 1
fi
if [[ -d "$STATE" && -n "$(find "$STATE" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "State directory is not empty; select a fresh ARCHIE_GIT_EXPERIENCE_STATE: $STATE" >&2
  exit 1
fi
mkdir -p "$STATE" "$EXPORT"

"$PYTHON" "$HERE/train_archie_git_experience.py" \
  --model "$MODEL" \
  --train-data "$DATA/git-experience.train.jsonl" \
  --development-data "$DATA/git-experience.development.jsonl" \
  --data-receipt "$DATA/git-experience-receipt.json" \
  --output "$STATE" \
  --device cuda \
  --steps "${ARCHIE_GIT_STEPS:-120}" \
  --gradient-accumulation "${ARCHIE_GIT_GRADIENT_ACCUMULATION:-1}" \
  --max-seq-length "${ARCHIE_GIT_SEQUENCE_LENGTH:-640}" \
  --max-target-tokens "${ARCHIE_GIT_TARGET_TOKENS:-256}" \
  --eval-episodes "${ARCHIE_GIT_EVAL_EPISODES:-64}" \
  --curiosity-seed-episodes "${ARCHIE_GIT_CURIOSITY_PROBES:-96}" \
  --curiosity-exploration "${ARCHIE_GIT_EXPLORATION_RATE:-0.15}" \
  --learning-rate "${ARCHIE_GIT_LEARNING_RATE:-3e-5}" \
  --preference-weight "${ARCHIE_GIT_PREFERENCE_WEIGHT:-0.6}" \
  --causal-margin "${ARCHIE_GIT_CAUSAL_MARGIN:-0.05}" \
  --save-every "${ARCHIE_GIT_SAVE_EVERY:-10}" \
  --no-gradient-checkpointing

cp "$STATE/archie-git-experience.pt" "$EXPORT/archie-git-experience.pt"
cp "$STATE/training-receipt.json" "$EXPORT/training-receipt.json"
echo "Archie real-experience model: $EXPORT/archie-git-experience.pt"
echo "Training receipt: $EXPORT/training-receipt.json"
