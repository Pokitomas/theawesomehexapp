# Archie Generation One architecture × quantization campaign

This lane compares model architecture and quantization together without pretending that uploaded source code is a trained model.

## Bound source roles

- **Unsloth** is an external training, merge, and export accelerator for the existing Hugging Face Qwen student lane. It is not vendored, trusted as runtime code, or treated as Archie’s brain.
- **Mamba** is a Generation One state-space experiment source. The uploaded tree contains Mamba, Mamba-2, and Mamba-3 code, but no Archie-trained checkpoint, quantized exporter, or admitted iPhone runtime.
- **RWKV-8** is a design source for matrix-state, low-rank-state, quantized-state, and sparse quantized-state experiments. The uploaded document is not an implementation or checkpoint.
- ArchiveBox, Crawl4AI, and Whisper remain possible archive, web-ingestion, and speech faculties. Kid Pix, PixelWater, hm, and voice-ai are excluded from the neural core.

Exact uploaded archive and tree identities are recorded in `product/archie-architecture-source-catalog.json`.

## Candidate matrix

The campaign keeps the existing Qwen3 GGUF controls:

- Q4_K_M
- Q5_K_M
- Q6_K
- Q8_0 diagnostic baseline

It adds blocked Generation One cells for:

- Mamba-2 weight-only INT8 and INT4
- Mamba-3 MIMO weight-only INT8 and INT4
- RWKV-8 matrix-state INT8
- RWKV-8 low-rank-state INT8
- RWKV-8 quantized-state INT6
- RWKV-8 sparse quantized-state INT6

These names define experiment cells, not claimed implementations. Only the Qwen GGUF controls currently have a materialization command, and even those require the merged checkpoint plus exact llama.cpp converter and quantizer inputs.

## Failure handling

Generate the immutable template:

```text
npm run archie:research:architectures
```

Evaluate a result packet:

```text
npm run archie:research:architectures:evaluate -- --results ./architecture-results.json
```

Known blockers such as a missing trained checkpoint, exporter, recurrent-state kernel, iPhone runtime, hidden evaluation, independent reproduction, or physical A15 evidence are preserved as expected failure receipts and do not abort the rest of the campaign. Any unknown failure code, comparison-binding mismatch, or incomplete independent device evidence blocks selection.

Completed candidates are comparable only when parameter budget, training-token budget, curriculum, hidden split, grader, workload set, and device floor are bound identically. The report returns a Pareto frontier rather than inventing one winner. No candidate is selected automatically.

## Truth boundary

The campaign is executable research infrastructure. It does not provide Mamba or RWKV weights, implement their mobile kernels, prove quality, or admit an iPhone model. Promotion still requires trained artifacts, hidden-split intelligence evidence, independent reproduction, and canonical physical-device evidence.
