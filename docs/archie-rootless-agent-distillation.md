# Archie rootless agent distillation

## Purpose

This lane tests whether agent behavior can be compiled into a small purpose-built neural policy without inheriting a foundation model. The teacher is a bounded corpus of agent and subagent trajectories. The deployed student starts from random weights and runs without a teacher model, network access, or tool router.

## Distinction from the Qwen lanes

The Qwen3 campaigns adapt an existing language model. This campaign does not load, quantize, merge, or depend on any pretrained model. It is therefore a higher-risk architecture experiment rather than a stronger version of LoRA.

## Teacher contract

Each JSONL record is one transition:

```json
{"episode_id":"...","step":0,"observation_tokens":[1,2,3],"action_token":7,"reward":0.5,"done":false}
```

Teacher traces may be produced by the primary agent or bounded subagents. Hidden states and teacher weights are forbidden. Tool outputs may appear only as already-recorded observations in the training corpus; they are not available to the deployed student.

## Engineered student

The student is an event-embedded recurrent state policy:

1. Observation tokens are embedded locally.
2. A recurrent state core updates a fixed set of latent slots.
3. An action head predicts the next native action token.
4. A value head predicts discounted return.
5. A state-consistency objective makes equivalent prefixes converge toward compatible latent states.
6. A counterfactual margin objective separates actions associated with failed and successful forks.

The architecture is deliberately not a text-completion transformer. It is a compact state machine trained to preserve decision structure.

## Training objective

The total loss is:

- teacher action cross-entropy;
- return regression;
- state consistency across equivalent prefixes;
- counterfactual action margin;
- entropy floor to avoid early policy collapse.

No claim is admitted from training loss alone. Evaluation must compare untouched episodes, long-horizon state retention, action accuracy, return, perturbation recovery, and memory/runtime against the frozen untrained student and the two Qwen lanes.

## Alienware execution method

The campaign uses the same self-hosted CUDA discipline as the existing Alienware lanes:

- explicit repository-owner authorization;
- CUDA-only preflight with no CPU fallback;
- local immutable teacher corpus;
- checkpoint manifests binding code, corpus, configuration, optimizer state, RNG state, and exact next optimizer step;
- stable resumable artifact names;
- no promotion until independent reproduction.

## Claim boundary

This is an executable experiment specification. It is not evidence that a scratch model can equal a foundation model, become generally intelligent, or operate autonomously. The radical hypothesis is falsified if it cannot beat simple behavioral baselines on untouched episodes under the same compute and memory envelope.
