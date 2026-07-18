#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: $0 <profile.json> <workspace> <trajectory-batch.json> <pair-output> <training-output> [model-dir]" >&2
  exit 2
fi

PROFILE=$1
WORKSPACE=$2
BATCH=$3
PAIR_OUTPUT=$4
TRAINING_OUTPUT=$5
MODEL_DIR=${6:-}

python3 foundry/archie-distill/compile_causal_pairs.py \
  --batch "$BATCH" \
  --output "$PAIR_OUTPUT" \
  --seed 3407 \
  --holdout-rate 0.2

ARGS=(
  --profile "$PROFILE"
  --workspace "$WORKSPACE"
  --preference-data "$PAIR_OUTPUT/causal-preference.train.jsonl"
  --preference-eval-data "$PAIR_OUTPUT/causal-preference.development.jsonl"
  --preference-receipt "$PAIR_OUTPUT/causal-preference-receipt.json"
  --output "$TRAINING_OUTPUT"
)

if [[ -n "$MODEL_DIR" ]]; then
  ARGS+=(--model-dir "$MODEL_DIR")
fi

python3 foundry/archie-distill/train_causal_divergence.py "${ARGS[@]}"
