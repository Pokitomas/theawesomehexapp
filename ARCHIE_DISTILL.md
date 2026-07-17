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
