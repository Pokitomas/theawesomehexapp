# Archie Rootless Native Student

## Claim

This is a third experimental training lane beside verifier-anchored causal-divergence QLoRA and information-budgeted causal-fork RSLoRA.

It deliberately uses **no pretrained root model**. The student begins from random weights and is engineered for Archie's bounded artifact task rather than inherited from a general chat model.

Teacher intelligence may come from authorized human operators, the current assistant, or bounded agent sub-processes. Teacher outputs are accepted only after deterministic verification. The resulting student runs without those teachers, without network inference, and without runtime tool orchestration.

Schema: `archie-rootless-native-student/v1`
Promotion: `research-only-not-admitted`

## Core hypothesis

A small purpose-built neural system can learn Archie's verified intention-to-artifact transformation more efficiently than adapting a general language model when:

1. the output space is constrained to a canonical artifact intermediate representation;
2. every demonstration contains machine-checkable state transitions and a final verified artifact;
3. training emphasizes causal edits, state persistence, and artifact validity instead of unrestricted next-token imitation;
4. the local CUDA machine repeatedly resumes the same sealed training state until the bounded curriculum is exhausted.

## Architecture

The student is a random-initialized recurrent state-space transducer with four learned components:

- **Intent encoder**: converts the request and bounded context into a compact latent goal state.
- **Persistent workspace**: fixed-size recurrent slots representing files, constraints, unresolved obligations, and verification state.
- **Artifact decoder**: emits a canonical artifact IR rather than prose or tool calls.
- **Verifier-value head**: predicts whether each proposed state transition and final artifact will pass the bound verifier suite.

The artifact IR is compiled by deterministic repository code. Compilation is not model reasoning and is not an external AI tool. The admitted runtime is therefore:

```text
request bytes
  -> local neural student
  -> canonical artifact IR
  -> deterministic compiler
  -> finished artifact bytes
```

No foundation-model checkpoint, remote model endpoint, agent loop, shell planner, browser, or generic tool router is required at inference time.

## Teacher protocol

Teachers do not donate weights. They produce signed episodes:

```text
request
  + constraints
  + initial workspace
  + ordered state deltas
  + canonical artifact IR
  + compiled artifact digest
  + verifier results
```

An episode is trainable only when:

- request bytes and constraints are immutable;
- every state delta is schema-valid;
- the deterministic compiler succeeds;
- the artifact digest binds the exact output;
- all required verifiers pass;
- no hidden remote dependency is present in the artifact;
- teacher identity and generation lineage are recorded.

Rejected or failed episodes remain useful as contrastive branches when a verified repaired descendant exists.

## Objective

The total loss is:

```text
L = L_ir
  + lambda_state * L_state_delta
  + lambda_value * L_verifier_value
  + lambda_branch * L_failed_vs_repaired
  + lambda_budget * L_workspace_budget
  + lambda_cycle * L_compile_reencode_cycle
```

Where:

- `L_ir` predicts the verified artifact IR;
- `L_state_delta` predicts each persistent-workspace transition;
- `L_verifier_value` predicts bound verifier outcomes;
- `L_failed_vs_repaired` prefers the first verified causal repair over its failed sibling;
- `L_workspace_budget` penalizes unnecessary active slots and recurrent steps;
- `L_compile_reencode_cycle` requires the compiled artifact, when deterministically re-encoded, to reconstruct the intended terminal state.

The model is trained from random initialization. Loading pretrained transformer, embedding, tokenizer, adapter, or language-model weights is a hard failure.

## Self-contained Alienware relay

This adapts the Squeeze Relay idea, but the training subject owns its full state rather than adapting an external base model.

GitHub publishes a sealed capsule containing:

- exact repository commit;
- architecture manifest;
- tokenizer or byte vocabulary generated from repository rules;
- verified teacher episodes;
- deterministic compiler and evaluator versions;
- random initialization seed;
- optimizer, scheduler, and curriculum state;
- expected parent checkpoint digest.

The Alienware worker outbound-polls for a capsule, verifies it, trains locally on CUDA, checkpoints the complete student and optimizer state, evaluates it, and returns signed evidence. The next capsule names the returned checkpoint digest as its parent. No inbound port, cloud model host, root checkpoint download, or arbitrary PR execution is required.

The resulting model can later continue learning from newly verified episodes by resuming its own checkpoint. This is "the Alienware method for itself": the machine carries forward the student's complete neural state rather than repeatedly mounting adapters onto a borrowed root model.

## Curriculum

Training proceeds through bounded stages:

1. byte and artifact-IR syntax;
2. deterministic compile success;
3. single-file artifact reconstruction;
4. multi-file state persistence;
5. failed-to-repaired causal branches;
6. held-out intention paraphrases;
7. resource-budget and latency pressure;
8. quantized local inference retention.

A stage advances only when its frozen gate passes. Failure resumes from the same parent checkpoint with a changed data capsule or declared hyperparameter change; it never silently resets to a new root.

## Evidence contract

A valid run must return:

- exact capsule and parent checkpoint digests;
- proof of random initialization for generation zero;
- proof that no pretrained tensors were loaded;
- CUDA device identity and measured GPU-seconds;
- changed student tensor digests;
- optimizer and scheduler continuity across interruption/resume;
- frozen development and held-out metrics;
- deterministic compiler success rate;
- artifact byte digests;
- quantized retention results;
- signed receipt.

## Falsification gates

Reject the hypothesis when any of the following remains true after the declared budget:

- it cannot beat a deterministic retrieval baseline on held-out requests;
- compile-validity rises while semantic verifier success does not;
- the workspace collapses to memorized templates;
- repaired-branch preference does not transfer to unseen lineages;
- quantization destroys the gain;
- total training compute exceeds the adapted 1.7B lane without a strict deployment advantage;
- inference still requires an agent, remote teacher, or generic tool loop.

## Relationship to the two current lanes

| Lane | Starting weights | Main signal | Runtime dependency |
|---|---|---|---|
| Verifier-anchored causal-divergence QLoRA | pretrained Qwen3-1.7B | failed trajectory vs verified repair | local adapted language model plus existing execution system |
| Information-budgeted causal-fork RSLoRA | pretrained Qwen3-1.7B | compute-focused causal repair specialists and exact fusion | local fused language-model adapter plus existing execution system |
| Rootless Native Student | random initialization | verified state transitions and artifact IR, including causal repairs | local student plus deterministic artifact compiler only |

## Truth boundary

This design is radical but not yet empirical evidence. A random-initialized student is not automatically more efficient, general, intelligent, or novel. Teacher episodes may still be expensive to generate. Deterministic compilation is permitted infrastructure, but any hidden AI inference or generic agent loop at runtime violates the method. No model is admitted until real CUDA training, held-out artifact success, quantized retention, independent reproduction, and human admission all pass.
