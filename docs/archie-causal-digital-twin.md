# Archie causal-divergence Linux digital twin

The Linux digital twin validates the exact staged bundle intended for Archie's first CUDA causal-divergence QLoRA attempt without performing neural training.

It exists to remove dependency, input, tokenization, receipt, output-path, and runner-plumbing uncertainty before the byte-identical bundle is handed to a real NVIDIA host. It is not a CPU trainer, CUDA simulator, model-quality test, or substitute for issue #588.

## Required result

A successful exact-host run emits:

```json
{
  "schema": "archie-neural-linux-digital-twin-receipt/v1",
  "executionMode": "linux-digital-twin",
  "neuralEvidence": false,
  "gradient_steps": 0,
  "optimizer_steps": 0,
  "adapter_artifacts": [],
  "neural_training_receipt_emitted": false,
  "promotion": "not-admitted"
}
```

The receipt also binds:

- the profile bytes and declared Qwen3-1.7B revision;
- the compiled training-plan bytes and digest;
- the causal-preference train/development bytes;
- the preference receipt digest;
- the complete local checkpoint directory identity;
- tokenizer artifacts;
- pinned package versions;
- local model configuration;
- deterministic tokenization order and sequence lengths;
- LoRA and Trainer construction parameters;
- the real `train_causal_divergence.py` process stopping at the canonical CUDA refusal.

The digital twin deliberately hides accelerator devices from the trainer subprocess and requires `torch.cuda.is_available()` to be false on the host. If the real trainer succeeds, creates an output directory, emits a neural receipt, or fails for any reason other than the canonical CPU-refusal boundary, the digital twin fails closed and emits no successful receipt.

## GitHub Actions lane

`.github/workflows/archie-causal-digital-twin.yml` runs dependency-light contract tests on pull requests and pushes. The exact bundle executes only through an owner-triggered `workflow_dispatch` on a narrowly labeled self-hosted Linux x64 runner.

Required repository variables:

| Variable | Meaning |
| --- | --- |
| `ARCHIE_DIGITAL_TWIN_RUNNER_READY` | Set to `1` only after the controlled non-CUDA Linux host and exact staged inputs pass local inspection. |
| `ARCHIE_DIGITAL_TWIN_RUNNER_LABEL` | Custom label on the eligible self-hosted Linux digital-twin runner. |
| `ARCHIE_TRAINING_PYTHON` | Exact Python executable containing the pinned causal QLoRA environment. |
| `ARCHIE_TRAINING_CONFIG_PATH` | Exact reviewed Archie workspace-compiler config. |
| `ARCHIE_TRAJECTORY_BATCH_PATH` | Exact admitted failed-to-verified-repair trajectory batch. |
| `ARCHIE_STUDENT_MODEL_DIR` | Exact local Qwen3-1.7B checkpoint at revision `8d4744f9e13072f4920c326350fa81eedb74eae9`. |
| `ARCHIE_TRAINING_OUTPUT_ROOT` | Writable root for unique, non-overwriting digital-twin outputs. |

The bound request is `.github/training/archie-digital-twin-request.json`. A missing variable produces `archie-causal-digital-twin-blocker/v1`; it is not a neural receipt.

## Direct execution

After compiling the exact workspace and causal pairs, run:

```bash
python foundry/archie-distill/run_causal_divergence_digital_twin.py \
  --profile maker/evaluations/archie-causal-divergence-qwen3-quality.json \
  --workspace /exact/run/workspace \
  --preference-data /exact/run/causal-pairs/causal-preference.train.jsonl \
  --preference-eval-data /exact/run/causal-pairs/causal-preference.development.jsonl \
  --preference-receipt /exact/run/causal-pairs/causal-preference-receipt.json \
  --model-dir /exact/models/Qwen3-1.7B-8d4744f9 \
  --output /exact/run/digital-twin-output
```

The output directory must not exist. The script also reserves a sibling `*-forbidden-neural-output` path for the real trainer refusal probe and fails if that path is created.

## Handoff to CUDA

A successful digital-twin receipt authorizes no neural claim. The next step is to copy the byte-identical config, trajectory batch, model directory, Python environment lock, repository revision, and output contract to the controlled NVIDIA host. Stage B must still prove:

- real CUDA hardware and memory evidence;
- NF4 local checkpoint loading;
- actual forward, backward, and optimizer steps;
- finite nonzero gradients;
- LoRA tensors changed from initialization;
- a bound adapter artifact;
- `archie-neural-causal-divergence-training-receipt/v1`;
- `archie-cuda-actions-causal-training-receipt/v1`;
- frozen-base comparison on untouched held-out data;
- `promotion: not-admitted` until independent admission gates pass.

## Truth boundary

The Linux digital twin is infrastructure and byte-integrity evidence. It is not neural evidence. Mocked CUDA, fake tensors, CPU fallback, model emulation, synthetic device metadata, or a successful digital-twin receipt do not satisfy issue #588 and must never be described as learned capability.
