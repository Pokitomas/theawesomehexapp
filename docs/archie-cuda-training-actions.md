# Archie CUDA training through GitHub Actions

This workflow is the execution bridge between the repository’s evidence-bound training compiler and the real CUDA-only trainer in `foundry/archie-distill/train.py`.

It does not make a CPU runner behave like a GPU runner, download unpinned weights, create synthetic receipts, or admit a trained model.

## Trigger and authorization

`.github/workflows/archie-cuda-training.yml` runs its contract checks on pull requests. A real attempt starts only from:

- a trusted push to `main` that changes `.github/training/archie-cuda-request.json`; or
- a manual workflow dispatch.

The authorization job runs first on a standard Ubuntu runner. It requires the GitHub actor to be the repository owner and requires every training variable below. Until `ARCHIE_CUDA_RUNNER_READY` is exactly `1`, the workflow does not queue the self-hosted job. It uploads an `archie-cuda-training-blocker/v1` receipt and comments on the issue bound by the request file.

## Required repository variables

Configure these under repository Actions variables:

| Variable | Meaning |
| --- | --- |
| `ARCHIE_CUDA_RUNNER_READY` | Set to `1` only after the runner and local inputs are actually ready. |
| `ARCHIE_CUDA_RUNNER_LABEL` | Custom label on the eligible self-hosted CUDA runner, such as `archie-cuda`. |
| `ARCHIE_TRAINING_PYTHON` | Exact executable path for the pinned CUDA QLoRA Python environment. |
| `ARCHIE_TRAINING_CONFIG_PATH` | Exact local path to the reviewed compiler config. |
| `ARCHIE_STUDENT_MODEL_DIR` | Exact local Hugging Face-format student checkpoint directory. |
| `ARCHIE_TRAINING_OUTPUT_ROOT` | Writable local root for unique Actions run outputs. |

The runner must match `self-hosted`, `linux`, `x64`, and the configured custom label. Labels route a job; they do not prove hardware. The workflow therefore checks `nvidia-smi`, `torch.cuda.is_available()`, GPU identity and VRAM, the pinned Python packages, the compiler config, the student checkpoint, and the output root again on the runner.

## Execution

For an authorized request, the CUDA job:

1. checks out the exact Actions revision;
2. installs only the locked Node dependencies used by the compiler;
3. emits `archie-cuda-runner-evidence/v1`;
4. compiles a new, non-overwriting digest-bound workspace;
5. runs the real offline NF4 QLoRA trainer against the pinned local checkpoint;
6. verifies `archie-neural-training-receipt/v2`;
7. rejects any receipt whose promotion is not `not-admitted`;
8. emits `archie-cuda-actions-training-receipt/v1`;
9. uploads the adapter/checkpoints, logs, runner evidence, and receipts for 14 days;
10. comments the terminal run state on the bound issue.

The workflow does not upload the compiled workspace or source datasets. Those remain local to the controlled runner.

## Retrying

Change `request_id` in `.github/training/archie-cuda-request.json` and merge that change to `main`, or manually dispatch the workflow with a new audit label.

Do not set the readiness flag merely to make the job queue. A missing runner, CUDA stack, pinned model, reviewed corpus/config, storage location, or dependency is a blocker. A completed training receipt still does not prove hidden-evaluation success, independent authority, clean reproduction, physical-device performance, intelligence, or admission.
