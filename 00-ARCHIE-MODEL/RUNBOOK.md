# Archie model runbook

This runbook follows the evidence order. Do not skip from code existence to a model claim.

## 1. Inspect the canonical identity

```bash
cat 00-ARCHIE-MODEL/MODEL.json
cat 00-ARCHIE-MODEL/STATUS.json
cat maker/evaluations/archie-information-budgeted-rslora.json
```

Confirm that the base is pinned to `Qwen/Qwen3-1.7B` revision `8d4744f9e13072f4920c326350fa81eedb74eae9` and the method is `information-budgeted-causal-fork-rslora/v1`.

## 2. Run dependency-light contracts

These checks validate the algorithmic plumbing without claiming a trained model:

```bash
python -m py_compile \
  foundry/archie-distill/information_budgeted_rslora.py \
  foundry/archie-distill/fuse_information_budgeted_adapters.py \
  foundry/archie-distill/test_information_budgeted_rslora.py

python foundry/archie-distill/test_information_budgeted_rslora.py
npm run test:archie:distill
npm run test:authority
```

Expected contract coverage:

- divergence supervision survives replay;
- estimated attention area falls on long pairs;
- repair lineages remain atomic;
- cached and live reference losses agree;
- both policy arms receive gradients;
- RSLoRA fallback is explicit;
- fused scaling is mathematically canonical;
- no candidate is promoted by the test.

## 3. Freeze the real training bundle

Before any CUDA run, bind and preserve:

- exact repository commit;
- Qwen3-1.7B checkpoint and tokenizer bytes;
- admitted trajectory batch;
- compiler and training configuration;
- profile JSON;
- Python and package lock;
- evaluation cases and split receipt;
- output root and runner identity.

The canonical workflow refuses execution when the required repository variables or local files are absent.

## 4. Configure the heterogeneous execution lane

Required repository variables:

```text
ARCHIE_SEGMENTED_DISTILL_READY=1
ARCHIE_SEGMENT_RUNNER_LABEL
ARCHIE_CUDA_RUNNER_LABELS
ARCHIE_FUSION_RUNNER_LABEL
ARCHIE_TRAINING_PYTHON
ARCHIE_TRAINING_CONFIG_PATH
ARCHIE_TRAJECTORY_BATCH_PATH
ARCHIE_STUDENT_MODEL_DIR
```

`ARCHIE_CUDA_RUNNER_LABELS` must be a JSON array of one or more self-hosted Linux x64 CUDA runner labels. The default canonical round uses two shards and therefore two rank-32 specialists, though one GPU label may service both sequentially.

## 5. Dispatch the canonical model run

```bash
gh workflow run archie-information-budgeted-rslora.yml \
  --ref main \
  -f request_id="archie-ib-rslora-$(date -u +%Y%m%dT%H%M%SZ)" \
  -f round=0 \
  -f shards=2 \
  -f max_fused_rank=64
```

The workflow must perform this sequence:

```text
compile verified repair pairs
→ create information-budgeted lineage-atomic shards
→ cache frozen-base reference scores
→ train each specialist on real CUDA
→ prove adapter tensors changed
→ compare every specialist with the frozen base
→ fuse only non-regressive specialists
→ compare the fused candidate with the frozen base
→ preserve non-admission until later gates pass
```

## 6. Inspect receipts, not just workflow color

A green workflow is insufficient. Require artifacts proving:

```text
real optimizer steps > 0
initial adapter digest != trained adapter digest
exact base and tokenizer identity
untouched held-out split identity
specialist comparison results
fusion source identities and weights
exact or bounded fusion reconstruction evidence
fused-candidate comparison results
promotion = not-admitted
```

A blocker or partial run is valid evidence but not model completion.

## 7. Quantize and test retention

Only a fused candidate that clears its full-sequence gate may proceed. Produce merged and GGUF candidates, then run the same case-level suite across:

```text
frozen base
fused adapter
merged checkpoint
quantized candidates
```

Critical cases must not regress. Bind every quantized artifact to its exact source candidate and device evidence.

## 8. Independently reproduce

Repeat the frozen bundle on another controlled machine. The reproduction must use the same source identities and independently generated runtime evidence. Do not admit a model from one machine's unexplained artifact.

## 9. Run the Archie real-life benchmark suite

Use [`BENCHMARKS.json`](./BENCHMARKS.json) as the registry. At minimum run:

- One Box, Weird Dream;
- Stranger's Repo;
- Learn the Exact Repair;
- Come Back Tomorrow;
- Don't Lie to Me;
- Laptop, Not Lab;
- Still Archie After Quantization.

Every result must include task, environment, time, cost, tools, interventions, outputs, tests, and exact model identity.

## 10. Admit or reject

Admission is a separate signed decision. Training code, gradient receipts, changed tensors, or one benchmark win cannot admit the model by themselves.

Until the complete evidence chain exists, the correct state remains:

```text
promotion: not-admitted
```