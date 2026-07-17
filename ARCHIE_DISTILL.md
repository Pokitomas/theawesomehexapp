# Archie local teacher/student distillation

This lane turns the existing evidence-bound Archie corpus and runtime into an explicit local experiment. It does **not** claim that Archie is a new foundation model, that a trained candidate is competent, or that any candidate is promoted.

The default profile pins Qwen3-14B Q4_K_M as the local teacher and Qwen3-1.7B as the student by exact repository revisions. The teacher artifact is accepted only when its SHA-256 matches. Model weights, caches, virtual environments, adapters, and generated candidates remain outside Git.

```text
archie distill init --workspace <path>
archie distill doctor --workspace <path> --runner <llama-completion>
archie distill teach --workspace <path> --runner <llama-completion>
archie distill attest-teacher --workspace <path> --reviewer-kind human --reviewer-id <id> \
  --accept "candidate-id::reason" --reject "candidate-id::reason" --confirm-inspected-all
archie distill import-teacher --workspace <path> --confirm-reviewed
```

Workspace initialization materializes the profile and sixteen evidence, diagnosis, security, operations, architecture, evaluation, and authority tasks as `curriculum.jsonl`. `teach` verifies the exact teacher digest, runs at temperature zero, checkpoints every candidate independently, rejects empty or contaminated runner output, and resumes matching partial work after interruption. It never silently admits generated text into training data.

An independent reviewer must bind the exact candidate-file digest and provide one reasoned accept/reject decision for every row. The separate import gate converts accepted rows to positive examples and rejected rows to explicit negative/suppression lessons. `foundry/archie-distill/train.py` is an explicit QLoRA/SFT entrypoint that consumes only reviewed positives and writes a non-promoted training receipt. Promotion still requires held-out comparison against the untouched student, prompt-only baseline, teacher-only path, exact authority checks, and clean-machine reproduction.

## Executable local neural boundary

The student training lane is **CUDA-only NF4 QLoRA**. It loads a local Hugging Face-format checkpoint in four-bit NF4 with double quantization, freezes the base weights, and updates LoRA adapter parameters only. It uses FP16 compute, packed examples, gradient checkpointing, micro-batch size one by default, gradient accumulation, and the paged 8-bit AdamW optimizer.

The trainer is deliberately offline and never falls back to full-precision CPU training. A missing CUDA device, missing local checkpoint, unavailable bitsandbytes stack, failed four-bit load, or unexpected trainable base parameter terminates the run without producing a successful neural receipt.

The receipt binds the profile, training plan, complete checkpoint identity, tokenizer identity, each dataset file, deterministic sample order, seed, GPU identity, CUDA/cuDNN and Python package versions, quantization and LoRA configuration, and every output adapter byte. Deterministic reproduction is claimed only for the same pinned checkpoint, data order, GPU class, CUDA stack, and library versions.

QLoRA training uses the Hugging Face-format student checkpoint. Q4_K_M GGUF is the local teacher or post-training inference format; it is not treated as a trainable QLoRA base artifact. After independent admission, a merged student may be quantized to GGUF for llama.cpp inference.
