#!/usr/bin/env bash
set -euo pipefail

required=(
  PY CONFIG MODEL PROFILE SEGMENTS REQUEST_ID CODE_REVISION SHARD_INDEX RUNG RUNG_COUNT
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
done

printf -v shard '%03d' "$SHARD_INDEX"
shard_dir="${SEGMENTS}/shard-${shard}"
test -x "$PY"
test -f "$CONFIG"
test -d "$MODEL"
test -f "$PROFILE"
test -f "$shard_dir/causal-preference.train.jsonl"
test -f "$shard_dir/causal-preference-receipt.json"

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/archie-elastic-rslora-r${RUNG}-s${shard}.XXXXXXXX")"
npm run archie:student:compile -- --config "$CONFIG" --output "$root/workspace"

if [[ "$RUNG" == "0" ]]; then
  "$PY" foundry/archie-distill/information_budgeted_rslora.py cache-reference \
    --preference-data "$shard_dir/causal-preference.train.jsonl" \
    --model-dir "$MODEL" --output "$root/reference-cache" \
    --max-seq-length 896 --prompt-replay-tokens 384 --prompt-head-tokens 32 \
    --shared-prefix-replay-tokens 96 --max-divergence-tokens 384
  resume_args=()
else
  if [[ -z "${RESUME_ROOT:-}" ]]; then
    printf 'Nonzero rung requires RESUME_ROOT.\n' >&2
    exit 2
  fi
  test -f "$RESUME_ROOT/bundle/elastic-rung-receipt.json"
  test -f "$RESUME_ROOT/reference-cache/reference-cache-receipt.json"
  cp -a "$RESUME_ROOT/reference-cache" "$root/reference-cache"
  resume_args=(--resume-bundle "$RESUME_ROOT/bundle")
fi

ARCHIE_COMPUTE_PROVIDER="${ARCHIE_COMPUTE_PROVIDER:-unlabeled-external-runner}" \
ARCHIE_RUNNER_LABELS="${ARCHIE_RUNNER_LABELS:-}" \
"$PY" foundry/archie-distill/elastic_information_budgeted_rslora.py train-rung \
  --profile "$PROFILE" --training-config "$CONFIG" --workspace "$root/workspace" \
  --preference-data "$shard_dir/causal-preference.train.jsonl" \
  --preference-receipt "$shard_dir/causal-preference-receipt.json" \
  --reference-cache "$root/reference-cache" --model-dir "$MODEL" \
  --output "$root/bundle" "${resume_args[@]}" \
  --request-id "$REQUEST_ID" --code-revision "$CODE_REVISION" \
  --shard-index "$SHARD_INDEX" --rung "$RUNG" --rung-count "$RUNG_COUNT" \
  --max-seq-length 896 --prompt-replay-tokens 384 --prompt-head-tokens 32 \
  --shared-prefix-replay-tokens 96 --max-divergence-tokens 384 \
  --gradient-accumulation-steps 8 --batch-size 1 --beta 0.1 \
  --causal-margin 0.2 --sft-weight 0.35

export_root="$root/export"
mkdir -p "$export_root"
cp -a "$root/bundle" "$export_root/bundle"
cp -a "$root/reference-cache" "$export_root/reference-cache"
# The attempt-specific artifact is immutable evidence. The stable alias is an overwriteable handoff.
artifact_name="archie-elastic-rslora-rung-${RUNG}-shard-${shard}-${GITHUB_RUN_ID:-local}"
evidence_artifact_name="${artifact_name}-${GITHUB_RUN_ATTEMPT:-1}"
output_file="${OUTPUT_FILE:-${GITHUB_OUTPUT:-}}"
if [[ -z "$output_file" ]]; then
  printf 'No GitHub output file is available.\n' >&2
  exit 2
fi
printf 'artifact_name=%s\nevidence_artifact_name=%s\nartifact_path=%s\n' \
  "$artifact_name" "$evidence_artifact_name" "$export_root" >> "$output_file"
