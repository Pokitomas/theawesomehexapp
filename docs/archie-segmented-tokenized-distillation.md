# Archie recursive segmented tokenized distillation

## Algorithm

```text
verified failed→repair trajectories
  → causal pair compiler
  → exact student tokenizer accounting
  → lineage-atomic token-balanced shards
  → parallel CUDA NF4 QLoRA specialists
  → deterministic initial-vs-trained tensor proof
  → frozen-base-vs-adapter global held-out comparison
  → weighted LoRA delta fusion
      exact: A*=concat(Aᵢ), B*=concat(wᵢ·scaleᵢ·Bᵢ)
      therefore: B*·A*=Σ wᵢ·scaleᵢ·Bᵢ·Aᵢ
  → optional bounded SVD rank compression
  → final frozen-base-vs-fused global held-out gate
  → safe merge into the exact base checkpoint
  → GGUF Q4_K_M/Q5_K_M/Q6_K materialization
  → case-level base/fused/quantized evaluation
  → only evaluator failures become priorities for the next bounded round
```

The method identifier is:

```text
recursive-segmented-tokenized-distillation/v1
```

This is a repository method, not a claim of globally unique prior art.

## Machine roles

```text
segment runner
  CPU + local trajectory batch + exact tokenizer/model directory

CUDA runners
  one or more Linux NVIDIA workers with the same pinned base checkpoint
  each worker trains one tokenizer-balanced specialist shard
  the first listed CUDA runner also evaluates the final fused adapter

fusion runner
  CPU/high-memory Linux worker with pinned torch + safetensors
  does not need the base checkpoint

quant runner
  CPU/high-memory Linux worker with the base checkpoint,
  convert_hf_to_gguf.py, and llama-quantize
```

One physical machine may carry multiple labels. Different machine types may join the same round because all cross-machine state is artifact- and digest-bound.

## Required repository variables

```bash
gh variable set ARCHIE_SEGMENTED_DISTILL_READY --body '1'
gh variable set ARCHIE_SEGMENT_RUNNER_LABEL --body 'archie-segment'
gh variable set ARCHIE_CUDA_RUNNER_LABELS --body '["archie-cuda-a","archie-cuda-b"]'
gh variable set ARCHIE_FUSION_RUNNER_LABEL --body 'archie-fusion'

gh variable set ARCHIE_TRAINING_PYTHON --body '/opt/archie/venv/bin/python'
gh variable set ARCHIE_TRAINING_CONFIG_PATH --body '/opt/archie/inputs/training-config.json'
gh variable set ARCHIE_TRAJECTORY_BATCH_PATH --body '/opt/archie/inputs/trajectory-batch.json'
gh variable set ARCHIE_STUDENT_MODEL_DIR --body '/opt/archie/models/Qwen3-1.7B'
```

Optional quantization lane:

```bash
gh variable set ARCHIE_QUANT_RUNNER_READY --body '1'
gh variable set ARCHIE_QUANT_RUNNER_LABEL --body 'archie-quant'
gh variable set ARCHIE_LLAMA_CONVERTER --body '/opt/llama.cpp/convert_hf_to_gguf.py'
gh variable set ARCHIE_LLAMA_QUANTIZER --body '/opt/llama.cpp/build/bin/llama-quantize'
```

## Start round zero from one terminal

```bash
gh workflow run archie-segmented-distillation.yml \
  --ref main \
  -f request_id="archie-rstd-$(date -u +%Y%m%dT%H%M%SZ)" \
  -f round=0 \
  -f shards=4 \
  -f max_fused_rank=64

RUN_ID="$(gh run list \
  --workflow archie-segmented-distillation.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
```

The workflow refuses to queue when the actor is not the repository owner, readiness is disabled, a runner label is missing, or the CUDA label list is invalid. Each self-hosted job fails before its operation when a pinned local input is absent.

## Manual CPU segmentation

```bash
PY=/opt/archie/venv/bin/python
MODEL=/opt/archie/models/Qwen3-1.7B
BATCH=/opt/archie/inputs/trajectory-batch.json
ROOT="$(mktemp -d)"

"$PY" foundry/archie-distill/compile_causal_pairs.py \
  --batch "$BATCH" \
  --output "$ROOT/pairs" \
  --seed 3407 \
  --holdout-rate 0.2

"$PY" foundry/archie-distill/segment_causal_pairs.py \
  --train "$ROOT/pairs/causal-preference.train.jsonl" \
  --development "$ROOT/pairs/causal-preference.development.jsonl" \
  --pair-receipt "$ROOT/pairs/causal-preference-receipt.json" \
  --tokenizer-dir "$MODEL" \
  --output "$ROOT/segments" \
  --shards 4 \
  --seed 3407 \
  --round 0 \
  --request-id archie-rstd-manual-0 \
  --code-revision "$(git rev-parse HEAD)"
```

Each shard contains:

```text
causal-preference.train.jsonl
causal-preference.development.jsonl
causal-preference-receipt.json
shard-receipt.json
```

The development split is copied unchanged to every shard so specialist scores are comparable.

## Mandatory specialist proof

After each existing `train_causal_divergence.py` run:

```bash
"$PY" foundry/archie-distill/verify_segment_adapter.py \
  --profile maker/evaluations/archie-causal-divergence-qwen3-quality.json \
  --model-dir "$MODEL" \
  --adapter-dir "$SHARD_OUTPUT/adapter" \
  --evaluation-data "$SHARD/causal-preference.development.jsonl" \
  --training-receipt "$SHARD_OUTPUT/training-receipt.json" \
  --shard-receipt "$SHARD/shard-receipt.json" \
  --output "$SHARD_OUTPUT/verification"
```

The verifier fails unless:

```text
real CUDA is available
NF4 loading succeeds
saved tensor keys match deterministic LoRA initialization
at least one LoRA tensor digest changes
aggregate tensor delta is nonzero
the held-out bytes match the shard receipt
base and adapter are evaluated on the same held-out pairs
promotion remains not-admitted
```

## Delta-space fusion

Create a local fusion request:

```json
{
  "schema": "archie-segment-adapter-fusion-request/v1",
  "seed": 3407,
  "adapters": [
    {
      "adapter_dir": "./shard-000/adapter",
      "verification_receipt": "./shard-000/segment-verification-receipt.json"
    },
    {
      "adapter_dir": "./shard-001/adapter",
      "verification_receipt": "./shard-001/segment-verification-receipt.json"
    }
  ]
}
```

Fuse without mathematically invalid factor averaging:

```bash
"$PY" foundry/archie-distill/fuse_segment_adapters.py \
  --request ./fusion-request.json \
  --output ./fused \
  --max-rank 64
```

With four rank-16 adapters and `--max-rank 64`, fusion is exact rank concatenation. A lower maximum invokes deterministic truncated SVD and records the relative Frobenius reconstruction error per module.

## Mandatory fused-candidate proof

Fusion is not accepted merely because its source specialists passed independently. Evaluate the final fused delta against the same exact frozen base and global held-out split:

```bash
"$PY" foundry/archie-distill/evaluate_fused_adapter.py \
  --profile maker/evaluations/archie-causal-divergence-qwen3-quality.json \
  --model-dir "$MODEL" \
  --adapter-dir ./fused/adapter \
  --fusion-receipt ./fused/fusion-receipt.json \
  --segmentation-receipt "$ROOT/segments/segmentation-receipt.json" \
  --evaluation-data "$ROOT/segments/shard-000/causal-preference.development.jsonl" \
  --output ./fused-evaluation
```

This gate requires all of the following before quantization:

```text
fusion receipt and adapter bytes match
exact base checkpoint digest matches
held-out split matches the segmentation receipt
no base-success pair regresses
weighted pair accuracy does not decrease
accuracy, margin, or chosen-target likelihood improves strictly
promotion remains not-admitted
```

## Merge and quantize

Run this only after `fused-adapter-evaluation-receipt.json` reports both `evaluation_passed: true` and `quantization_eligible: true`.

```bash
"$PY" foundry/archie-distill/materialize_fused_adapter.py \
  --model-dir "$MODEL" \
  --adapter-dir ./fused/adapter \
  --fusion-receipt ./fused/fusion-receipt.json \
  --output ./merged \
  --device cpu

REVISION="$("$PY" - <<'PY'
import json
print(json.load(open('./fused/fusion-receipt.json'))['base_checkpoint_directory_digest'])
PY
)"

node scripts/archie-student-quantize.mjs run \
  --model-dir ./merged \
  --model-id archie-segmented-fused \
  --model-revision-sha256 "$REVISION" \
  --converter /opt/llama.cpp/convert_hf_to_gguf.py \
  --quantizer /opt/llama.cpp/build/bin/llama-quantize \
  --python "$PY" \
  --output-dir ./quantized \
  --quantization Q4_K_M \
  --quantization Q5_K_M \
  --quantization Q6_K
```

## Evaluation receipt required for recursion

```json
{
  "schema": "archie-segmented-distillation-evaluation/v1",
  "method": "recursive-segmented-tokenized-distillation/v1",
  "round": 0,
  "fusion_receipt_digest": "<sha256>",
  "cases": [
    {
      "pair_id": "pair_<id>",
      "pair_digest": "<sha256>",
      "evaluator_digest": "<sha256>",
      "base": { "passed": false, "score": 0.20 },
      "adapter": { "passed": true, "score": 0.84 },
      "quantized": {
        "Q4_K_M": { "passed": false, "quality_retention": 0.81 },
        "Q5_K_M": { "passed": true, "quality_retention": 0.98 },
        "Q6_K": { "passed": true, "quality_retention": 0.99 }
      }
    }
  ],
  "promotion": "not-admitted",
  "receipt_digest": "<digest of the body without this field>"
}
```

Create the next bounded priority set:

```bash
"$PY" foundry/archie-distill/decide_recursive_round.py \
  --evaluation ./evaluation-receipt.json \
  --pair-data "$ROOT/pairs/causal-preference.train.jsonl" \
  --pair-data "$ROOT/pairs/causal-preference.development.jsonl" \
  --output ./round-decision \
  --max-rounds 3 \
  --quant-retention-floor 0.97
```

Run the next round only when `continue_training` is true:

```bash
gh workflow run archie-segmented-distillation.yml \
  --ref main \
  -f request_id="archie-rstd-round-1" \
  -f round=1 \
  -f shards=4 \
  -f max_fused_rank=64 \
  -f quant_failures_path='/opt/archie/inputs/round-1/quantization-failures.json'
```

## Truth boundary

```text
CPU segmentation is useful but is not training.
CUDA specialist receipts prove local gradient runs only.
Changed-tensor receipts prove adapter bytes changed only.
Per-shard held-out deltas are bounded to the exact supplied split.
The final fused adapter must independently beat the frozen base without pair regression.
Fusion creates a candidate and never admits it.
GGUF creation proves quantized artifacts exist, not that quality survived.
Recursion is allowed only from concrete evaluator failures.
No round may claim spontaneous intelligence, broad capability, or production admission.
```
