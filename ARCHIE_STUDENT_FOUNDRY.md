# Archie student foundry

The student foundry converts accepted Archie corpus examples into deterministic local training inputs and executes a declared local trainer without a shell or frontier API.

## Prepare a pack

```text
node scripts/archie-student-foundry.mjs prepare \
  --corpus-root ~/.archie/corpus \
  --output-dir ./student-pack \
  --holdout-rate 0.2 \
  --split-salt project-heldout-v1
```

The pack contains:

- `train.jsonl` — accepted supervised examples;
- `heldout.jsonl` — accepted examples withheld by source group;
- `negative-train.jsonl` — retained negative/suppression lessons;
- `negative-heldout.jsonl` — withheld negative lessons;
- `manifest.json` — exact bytes, row counts, SHA-256 digests, split algorithm, source-group assignments, prompt digest, and pack digest.

Examples sharing the same source record remain in one split. The split is deterministic from a caller-selected salt and source-group identity. Pack creation fails when it cannot preserve at least one positive training example or, when multiple positive groups exist, a positive held-out example. Changing the salt creates an explicit different split rather than silently moving examples.

The source corpus remains authoritative. The foundry does not mutate corpus objects, examples, or ledgers.

## Declare a trainer

A trainer contract uses `archie-student-trainer/v1`:

```json
{
  "schema": "archie-student-trainer/v1",
  "program": "python",
  "args": [
    "train_adapter.py",
    "--train", "{train_jsonl}",
    "--heldout", "{heldout_jsonl}",
    "--negative-train", "{negative_train_jsonl}",
    "--negative-heldout", "{negative_heldout_jsonl}",
    "--output-dir", "{output_dir}",
    "--base-model", "{base_model_id}",
    "--seed", "{seed}"
  ],
  "base_model": {
    "id": "open-student-base",
    "digest": "<lowercase SHA-256>"
  },
  "output_artifact": "student.gguf",
  "metrics_file": "metrics.json",
  "seed": 17,
  "timeout_ms": 3600000,
  "optimizer": {
    "name": "lora",
    "learning_rate": 0.0002,
    "epochs": 1
  },
  "teacher_ids": ["teacher-model-id"]
}
```

Only a PATH executable name is admitted. Arguments are passed directly through `execFile`; there is no shell. Supported placeholders are limited to the four pack files, output directory, base model ID, and seed. The trainer environment contains only bounded local execution variables and does not inherit frontier API keys.

The trainer must write a non-empty artifact at `output_artifact` and a JSON object at `metrics_file`.

## Execute training

```text
node scripts/archie-student-foundry.mjs train \
  --pack ./student-pack \
  --config ./trainer.json \
  --output-dir ./student-run
```

A completed run emits `archie-student-training-receipt/v1` binding:

- pack, training, and held-out data digests;
- normalized trainer and optimizer digests;
- base model ID and digest;
- exact program, expanded arguments, and command digest;
- seed and teacher IDs;
- exit result and duration;
- candidate artifact bytes and SHA-256 digest;
- metrics value and digest;
- an evaluation receipt digest tied to the held-out data;
- an explicit non-promotion claim boundary.

Failed trainer processes are preserved in a `.failed-<digest>` directory with a deterministic failure receipt. A failed run never receives an artifact or evaluation digest.

## Checkpoint handoff

The receipt supplies values required by `archie checkpoint`:

- `training_data_digest`;
- `training_config_digest`;
- `optimizer_digest`;
- `evaluation_receipt_digest`;
- `seed`;
- `teacher_ids`;
- candidate artifact digest and path.

The caller must still provide the trajectory digest, authority receipt digest, exact installed parent expectations, candidate model metadata, and any rejected checkpoint digests. The checkpoint command then enforces the immutable architecture/runtime boundary and creates the signed encrypted package.

## Claim boundary

This is a provider-neutral local training orchestrator and evidence contract. The repository does not bundle a base model, training framework, GPU environment, dataset license, or trained neural checkpoint. Fixture trainers prove process and receipt plumbing only.

A real Archie student claim begins only after an identified local trainer produces an artifact from admitted data and POK-41 independently measures it against held-out teacher-only, symbolic-only, fuzzy-recall, and current-checkpoint baselines under matched compute.
