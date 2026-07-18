# Archie causal-divergence CUDA training through GitHub Actions

This workflow is the execution bridge between the merged verifier-anchored causal-divergence method and a real CUDA host. It uses `compile_causal_pairs.py` plus `train_causal_divergence.py`; it no longer routes the requested run through the older generic multilane SFT trainer.

It does not make a CPU runner behave like a GPU runner, download unpinned weights, fabricate receipts, or admit a trained model. The practical workaround for a machine without CUDA is a controlled self-hosted or ephemeral Linux CUDA runner carrying the exact local model and evidence inputs.

## Trigger and authorization

`.github/workflows/archie-cuda-training.yml` runs contract checks on pull requests. A real attempt starts only from:

- a trusted push to `main` that changes `.github/training/archie-cuda-request.json`; or
- a manual workflow dispatch.

The authorization job runs on a standard Ubuntu runner. It requires the repository owner, the v2 request method, and every variable below. Until `ARCHIE_CUDA_RUNNER_READY` is exactly `1`, no GPU job is queued. The workflow emits `archie-cuda-training-blocker/v2` and comments on the bound GitHub issue.

## Required repository variables

| Variable | Meaning |
| --- | --- |
| `ARCHIE_CUDA_RUNNER_READY` | Set to `1` only after the CUDA runner and exact local inputs are ready. |
| `ARCHIE_CUDA_RUNNER_LABEL` | Custom label on the eligible self-hosted or ephemeral CUDA runner, such as `archie-cuda`. |
| `ARCHIE_TRAINING_PYTHON` | Exact executable path for the pinned CUDA QLoRA Python environment. |
| `ARCHIE_TRAINING_CONFIG_PATH` | Exact local path to the reviewed workspace compiler config. |
| `ARCHIE_TRAJECTORY_BATCH_PATH` | Exact local path to an admitted `archie-trajectory-batch/v1` containing failed trajectories and verified descendant repairs. |
| `ARCHIE_STUDENT_MODEL_DIR` | Exact local Hugging Face-format Qwen3-1.7B checkpoint directory matching the profile revision. |
| `ARCHIE_TRAINING_OUTPUT_ROOT` | Writable local root for unique, non-overwriting run outputs. |

The runner must match `self-hosted`, `linux`, `x64`, and the configured custom label. Labels only route the job. Preflight separately proves `nvidia-smi`, `torch.cuda.is_available()`, GPU identity and VRAM, pinned package availability, the model directory, and SHA-256 identities for the profile, config, trajectory batch, trainer, and pair compiler.

## Exact execution

For an authorized request, the CUDA job:

1. checks out the exact Actions revision;
2. installs the locked Node dependencies used by the workspace compiler;
3. emits `archie-cuda-causal-runner-evidence/v1`;
4. compiles a new digest-bound training workspace;
5. deterministically compiles admitted failed→verified-repair pairs and a bound pair receipt;
6. runs offline NF4 QLoRA with the frozen-base-reference causal-divergence objective;
7. verifies `archie-neural-causal-divergence-training-receipt/v1`, the exact method, pair bytes, GPU identity, adapter artifacts, and `promotion: not-admitted`;
8. emits `archie-cuda-actions-causal-training-receipt/v1`;
9. uploads the adapter/checkpoints, logs, runner evidence, and receipts for 14 days;
10. comments the terminal run state on GitHub #583.

The source trajectory batch, compiled workspace, and compiled preference rows remain on the controlled runner. They are not uploaded as Actions artifacts.

## Runner choices

A local Windows machine can participate only through WSL2 when it has a supported NVIDIA GPU and the Windows NVIDIA driver exposes CUDA to WSL. A machine without a supported NVIDIA GPU cannot be converted into a CUDA trainer by software. Use an ephemeral Linux GPU host, register it as a narrowly labeled self-hosted runner, place the pinned model/config/batch on its local disk, run one request, then remove the runner and retained inputs according to the operator's data policy.

Do not expose a persistent self-hosted runner to untrusted pull-request code. The real training job is owner-authorized and does not run for pull requests.

## Retrying and promotion boundary

Change `request_id` in `.github/training/archie-cuda-request.json` and merge it to `main`, or manually dispatch with a new audit label. Do not set readiness merely to make a job queue.

A successful receipt proves only that the exact CUDA gradient run produced a bound adapter. The QLoRA campaign is not the separate retrieval/graph/external-memory research lane; those candidates need their own identities and evaluation receipts rather than being represented as neural-adapter output. POK-48 and POK-66 still govern normalized candidate and hidden-evaluation contracts; safety/authority non-regression, clean reproduction, native runtime, and physical-device admission remain separate gates.
