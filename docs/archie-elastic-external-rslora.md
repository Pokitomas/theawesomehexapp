# Archie elastic external RSLoRA compute fabric

## Decision

The information-budgeted RSLoRA campaign may execute on external CUDA machines without making one long-lived runner process the unit of truth.

The canonical model, tokenizer revision, causal-fork objective, two-epoch optimizer budget, frozen development comparison, exact adapter fusion, and `not-admitted` boundary remain unchanged. Only execution is partitioned.

```text
immutable segmented shard
  -> frozen-reference cache
  -> optimizer rung 0 + full Trainer checkpoint
  -> artifact-bound resume on a compatible CUDA runner
  -> optimizer rung 1 ... rung N
  -> final adapter verification
  -> exact scale-aware fusion
  -> frozen full-sequence evaluation
```

## Why this exists

The previous workflow treated an entire specialist run as one GitHub Actions job. A runner timeout or preemption could erase useful optimizer work even when the GPU had already completed most of the campaign. Increasing the timeout merely enlarged the failure domain.

The elastic lane instead makes a durable optimizer-state checkpoint the handoff boundary. Each rung is a separate job and artifact. A later rung can run on the same machine, a replacement self-hosted runner, or another external provider label, provided the exact model directory, tokenizer, dataset, profile, code revision, and predecessor receipt all match.

## Preserved budget

Rungs do not multiply training. The wrapper computes the canonical total optimizer steps from:

```text
training rows
batch size
gradient accumulation
profile epochs
```

It then divides that fixed total into one to four strictly increasing cumulative targets. Four rungs are four resumable slices of the same two-epoch campaign, not eight epochs or four independent restarts.

## Durable rung receipt

Every rung publishes:

- request, source revision, shard, rung, and provider identity;
- canonical and effective profile hashes;
- exact dataset, causal-pair receipt, reference-cache, and base-checkpoint identities;
- previous and target optimizer steps;
- parent rung receipt digest;
- full model, optimizer, scheduler, RNG, and Trainer-state checkpoint manifest;
- final adapter training receipt;
- GPU/runtime identity and elapsed wall time;
- `promotion: not-admitted`.

Resume fails closed when any bound identity or checkpoint byte differs. The preceding checkpoint must contain optimizer state and its `trainer_state.json` global step must equal the exact prior rung target.

## External runner configuration

The repository variables are the provider-neutral control plane:

```text
ARCHIE_CUDA_RUNNER_LABELS   JSON array of self-hosted CUDA labels
ARCHIE_CUDA_PROVIDER_NAMES  optional JSON array of human-readable providers
```

Example:

```json
["cuda-runpod-a100", "cuda-lambda-a10"]
```

```json
["runpod-a100", "lambda-a10"]
```

The provider names are evidence labels only. Credentials, rental APIs, SSH keys, model weights, and local data paths remain outside repository source and artifacts.

## Dispatch

```bash
gh workflow run archie-information-budgeted-rslora.yml \
  --ref agent/archie-elastic-external-rslora-20260721 \
  -f request_id="archie-elastic-rslora-$(date -u +%Y%m%dT%H%M%SZ)" \
  -f round=0 \
  -f shards=2 \
  -f rungs=4 \
  -f max_fused_rank=64
```

The owner-only authorization gate still requires the configured segment, CUDA, fusion, Python, model, trajectory, and training-config variables. Missing infrastructure produces an explicit blocker instead of a CPU rehearsal or fabricated training claim.

## Failure semantics

- A failed rung preserves all earlier rung artifacts.
- A replacement runner may resume only from the immediately preceding verified rung.
- A missing optimizer state is not a checkpoint.
- Replaying a rung with different bytes, code, data, model, or profile is rejected.
- Final adapter verification and fusion never consume an incomplete rung.
- No result is admitted without the unchanged frozen comparison, later quantization retention, and independent reproduction.

## Research implication

This changes the practical search space. Specialist count, provider diversity, GPU type, and interruption rate can scale independently of one machine's uptime while retaining exact causal lineage. It does not itself improve the model; it makes larger and more radical experiments falsifiable instead of timeout-shaped.
