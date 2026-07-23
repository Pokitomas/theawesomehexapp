# Archie student training compiler

For the zero-generated-example repository-transition lane, see `docs/ARCHIE-REAL-GIT-EXPERIENCE.md`. It trains full weights on real parent blobs, human commit messages, committed patches, temporally held-out successors, and counterfactual patches drawn from other real commits.

Archie’s training compiler joins the corpus, trajectory, state, and checkpoint contracts into one reproducible training workspace.

It does **not** claim that training occurred, that a student is admitted, or that Archie is frontier-capable. It creates exact inputs for an explicit trainer and exact receipts that later admission can verify.

## Inputs

A compiler config references:

- an exact `archie-distill-profile/v1` with a 40-character student revision;
- an `archie-state-contract/v1` separating immutable architecture/authority from mutable learned state;
- zero or more Sidepus diet manifests, export receipts, and exported JSONL files;
- zero or more admitted `archie-trajectory-batch/v1` files;
- zero or more reviewed `archie-distillation-example/v1` JSONL files;
- the exact Git object ID of the compiler/training code.

Example:

```json
{
  "profile": "./profile.json",
  "state_contract": "./state-contract.json",
  "sidepus": [
    {
      "manifest": "./sidepus/diet-manifest.json",
      "export_receipt": "./sidepus/export-receipt.json",
      "export_jsonl": "./sidepus/train.jsonl"
    }
  ],
  "trajectory_batches": [
    "./trajectories/admitted-batch.json"
  ],
  "distillation_jsonl": [
    "./distill/reviewed-train.jsonl"
  ],
  "code_commit": "0123456789abcdef0123456789abcdef01234567"
}
```

Compile atomically:

```bash
npm run archie:student:compile -- \
  --config ./training/config.json \
  --output ./training/workspace
```

The command refuses to overwrite an existing workspace.

## Evidence checks

Compilation fails closed when:

- the profile does not pin an exact student revision;
- a state-contract digest is invalid;
- a Sidepus export receipt does not match the exact export bytes;
- the exported text does not hash to the selected Sidepus object digest;
- selected documents are absent, duplicated, or replaced;
- a trajectory batch digest is invalid;
- a trajectory lacks an admitted positive or negative receipt;
- duplicate sample identities contain conflicting content;
- a checkpoint later names different code, datasets, trajectory batches, runtime ABI, or immutable state.

Sidepus’s Python-generated semantic manifest digest is retained as authority, while the compiler also records the raw manifest file SHA-256. This avoids silently reinterpreting cross-language number serialization while still binding the exact file consumed.

## Dataset lanes

The workspace contains four digest-addressed JSONL datasets:

- `datasets/pretrain.train.jsonl` — Sidepus text for continued pretraining;
- `datasets/sft.train.jsonl` — verified positive trajectories and reviewed positive distillation examples;
- `datasets/negative.train.jsonl` — evidenced failures and reviewed negative examples for suppression/verifier training;
- `datasets/development-holdout.jsonl` — deterministic group-wise development holdout.

Source and trajectory groups are split atomically. One source group cannot appear in both training and development data. Development holdout results are explicitly **not promotion-eligible**; independent hidden evaluation remains mandatory.

## Workspace artifacts

The compiler writes:

- `training-plan.json` — deterministic stages, budgets, datasets, and exact evidence identities;
- `input-receipt.json` — digest-addressed receipt for all compiled inputs;
- `inputs/source-index.json` — observational source paths plus raw file SHA-256 and byte counts;
- `inputs/resolved-profile.json`;
- `inputs/state-contract.json`;
- the four dataset lanes.

Large Sidepus exports are not copied a second time. Their exact bytes are bound by the Sidepus export receipt and the source index, while the compiler emits the normalized training rows that the trainer consumes.

The broad-diet producer and direct Archie Hybrid integration are documented in `docs/ARCHIE-SIDEPUS-BROAD-DIET.md`. That path freezes local, pinned GitHub, URL, and Internet Archive objects before deterministic filtering, exact/normalized/near deduplication, modality-metadata observation, curriculum negotiation, and token-corpus compilation.

## Training and checkpoint receipts

After an explicit trainer produces model bytes, `createStudentTrainingReceipt` binds:

- the exact training plan and input digest;
- code commit;
- state contract;
- checkpoint and learned-state digest;
- every compiled dataset digest;
- every Sidepus manifest and trajectory batch;
- artifact path, SHA-256, size, format, model ID, and checkpoint ID;
- tokenizer, trainer identity, metrics, and run timestamps.

The receipt always states `promotion: not-admitted`. A checkpoint still requires the trusted signed runtime manifest, independent held-out evaluation, authority review, reproduction, resource/device evidence, and the existing student-admission and launch-frontier gates.

## Relationship to existing training

The existing `foundry/archie-distill/train.py` can consume `datasets/sft.train.jsonl` for supervised fine-tuning. Continued pretraining and negative/verifier training remain explicit separate stages and must not be silently collapsed into SFT.

The compiler can also emit the artifact/evidence input expected by the persistent Archie Trainer brain-package flow. The Trainer may assemble and evaluate candidates, but it cannot bypass checkpoint compatibility or admission.
