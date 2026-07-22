# Archie Rootless Native Student

## Claim

This is a third experimental training lane beside verifier-anchored causal-divergence QLoRA and information-budgeted causal-fork RSLoRA.

It deliberately uses **no pretrained root model**. The student begins from random weights and is engineered for Archie's bounded tasks rather than inherited from a general chat model.

Teacher intelligence may come from authorized human operators, the current assistant, or bounded agent subprocesses. Teacher outputs are accepted only after deterministic verification. The training loop is self-contained: the assistant or agent teachers create the curriculum, package the data, dispatch the Alienware capsule, inspect the receipts, and generate the next round without relying on an outside model-training service or separate cognitive orchestration tool.

The deployed student may still use Archie's repository-native tools, memory, retrieval, compilers, actuators, and execution systems.

Schema: `archie-rootless-native-student/v1`
Promotion: `research-only-not-admitted`

## Core hypothesis

A small purpose-built neural system can learn Archie's verified intention-to-action or intention-to-artifact transformation more efficiently than adapting a general language model when:

1. the student architecture is designed around Archie's state, action, memory, and artifact interfaces;
2. every demonstration contains machine-checkable state transitions and verified outcomes;
3. training emphasizes causal edits, state persistence, tool choice, and verifier value instead of unrestricted next-token imitation;
4. the local CUDA machine repeatedly resumes the same sealed student state until the bounded curriculum is exhausted;
5. the assistant and bounded agent subprocesses can operate the complete training cycle without an external fine-tuning platform or second training model.

## Architecture

The student is a random-initialized compact recurrent or state-space neural system with candidate components including:

- **Intent and observation encoder**: converts requests, context, tool observations, and bounded environment state into a compact latent goal state.
- **Persistent workspace**: fixed-size recurrent slots representing files, constraints, unresolved obligations, memory, and verification state.
- **Action and tool heads**: emit direct actions or choose among Archie's admitted tools.
- **Artifact decoder**: emits canonical artifact IR or bounded output tokens where appropriate.
- **Verifier-value head**: predicts whether proposed transitions and final outputs will pass bound verifiers.
- **Uncertainty and stop head**: halts or requests bounded clarification when confidence is insufficient.

No pretrained transformer, embedding model, vision model, tokenizer model, adapter, or inherited neural checkpoint is permitted in generation zero.

## Teacher protocol

Teachers do not donate weights. They produce signed episodes containing some or all of:

```text
request
constraints
initial workspace or observation
ordered actions, tool choices, or artifact transitions
resulting observations
verifier deltas
terminal artifact or world-state digest
terminal verifier results
teacher lineage
```

An episode is trainable only when:

- request bytes and constraints are immutable;
- every transition is schema-valid;
- tool results or artifact outputs are bound to exact evidence;
- required verifiers pass or the failure is explicitly retained as a contrastive branch;
- teacher identity and generation lineage are recorded.

Rejected or failed episodes remain useful when a verified repaired descendant exists.

## Objective

The total loss may combine:

```text
L = L_action_or_artifact
  + lambda_state * L_state_delta
  + lambda_value * L_verifier_value
  + lambda_branch * L_failed_vs_repaired
  + lambda_tool * L_tool_choice
  + lambda_memory * L_memory_consistency
  + lambda_stop * L_calibrated_stop
  + lambda_budget * L_compute_budget
```

The exact heads and losses are experimental variables. The invariant is that the model is trained from random initialization and carries forward only its own learned state.

## Self-contained Alienware relay

This adapts the Squeeze Relay idea, but the training subject owns its full state rather than adapting an external base model.

The assistant or its bounded subprocesses publish a sealed capsule containing:

- exact repository commit;
- architecture manifest;
- repository-native vocabulary or encoding rules;
- verified teacher episodes;
- deterministic verifier and evaluator versions;
- random initialization seed or parent student checkpoint digest;
- optimizer, scheduler, and curriculum state;
- expected output evidence.

The Alienware worker outbound-polls for the capsule, verifies it, trains locally on CUDA, checkpoints the complete student and optimizer state, evaluates it, and returns signed evidence. The next capsule names the returned checkpoint digest as its parent.

No hosted fine-tuning API, outside AutoML service, external experiment coordinator, borrowed root checkpoint, or manual CUDA operation between rounds is required. Repository scripts and CUDA libraries remain normal implementation machinery.

The assistant or agent teachers inspect the returned failures and metrics, synthesize harder or corrective episodes, adjust declared architecture or hyperparameters, and publish the next capsule. This is “the Alienware method for itself”: the machine carries forward the student's complete neural state rather than repeatedly mounting adapters onto a borrowed root model.

## Deployment forms

The trained student is not required to be tool-free. Valid forms include:

```text
request -> student -> artifact IR -> deterministic compiler
request -> student -> Archie tool selection -> verified execution
observation -> student -> bounded action -> next observation
request -> student -> memory/tool/artifact loop
```

The important boundary is that the student is the root policy. It may use tools, but it may not secretly forward cognition to another foundation model and claim that as its own capability.

## Curriculum

Training proceeds through bounded stages:

1. state and output syntax;
2. deterministic verifier success;
3. single-step artifact or tool outcomes;
4. multi-step state persistence;
5. failed-to-repaired causal branches;
6. held-out intention paraphrases and layouts;
7. tool selection and memory use;
8. resource-budget and latency pressure;
9. interruption and exact checkpoint resume;
10. quantized local inference retention.

A stage advances only when its frozen gate passes.

## Evidence contract

A valid run must return:

- exact capsule and parent checkpoint digests;
- proof of random initialization for generation zero;
- proof that no pretrained tensors were loaded;
- teacher-episode lineage;
- CUDA device identity and measured GPU-seconds;
- changed student tensor digests;
- optimizer and scheduler continuity across interruption/resume;
- frozen development and held-out metrics;
- tool, action, artifact, memory, and verifier metrics relevant to the chosen architecture;
- output or world-state digests;
- quantized retention results where applicable;
- signed receipt.

## Falsification gates

Reject the hypothesis when any of the following remains true after the declared budget:

- it cannot beat a deterministic retrieval or scripted baseline on held-out requests;
- verifier success rises only on memorized templates;
- the workspace collapses or fails to track persistent state;
- repaired-branch preference does not transfer to unseen lineages;
- tool use merely forwards difficult decisions to another model;
- exact training resume cannot be proven;
- quantization destroys the gain;
- total teacher-generation and CUDA compute exceeds the adapted 1.7B lane without a strict deployment, ownership, latency, memory, or continual-learning advantage.

## Relationship to the current lanes

| Lane | Starting weights | Training operator | Deployment |
|---|---|---|---|
| Verifier-anchored causal-divergence QLoRA | pretrained Qwen3-1.7B | repository QLoRA trainer | adapted language model plus Archie systems |
| Information-budgeted causal-fork RSLoRA | pretrained Qwen3-1.7B | repository RSLoRA specialists and fusion | fused adapted model plus Archie systems |
| Rootless Native Student | random initialization | assistant/agent teacher loop plus Alienware self-relay | student may emit artifacts, actions, or tool choices through Archie systems |

## Truth boundary

This design is radical but not yet empirical evidence. A random-initialized student is not automatically more efficient, general, intelligent, or novel. Teacher episodes may still be expensive to generate. Repository scripts, CUDA kernels, storage, and deterministic verifiers are still required. “No external tooling” means no outside cognitive training service or separate training operator is required; it does not mean the product cannot use tools. No model is admitted until real CUDA training, held-out success, quantized retention, independent reproduction, and human admission all pass.
