# Archie Rootless Direct-Action Student

## Claim

This is a separate forward experiment from the rootless artifact-IR student.

The system begins from random initialization. Its teachers are authorized assistant or bounded agent subprocesses, but teacher reasoning is not preserved as prose and teacher weights are never transferred. Verified teacher executions are reduced into compact observation/action/value trajectories. A purpose-built neural controller learns to update its own persistent state and emit bounded actions directly.

At deployment, the student does not call another model, invoke an agent, select a tool, or generate a plan for an external executor. The student itself is the policy.

Schema: `archie-rootless-direct-action-student/v1`
Status: `research-only-not-admitted`

## Core hypothesis

For a bounded device and artifact environment, intelligence can be distilled into a compact closed-loop neural policy more efficiently than into a general language model when the training target is the actual control process:

```text
observation -> latent state update -> action -> new observation -> terminal value
```

The teacher may use broad reasoning and tools while generating demonstrations. The student never sees the teacher's hidden chain of thought. It receives only causally sufficient, verifier-bound transitions.

## Engineered student

The student is initialized from random weights and contains:

- **multimodal observation encoder** for bounded screen, file-state, sensor, event, and request channels;
- **persistent recurrent world state** carried across actions without replaying a text transcript;
- **hierarchical action head** that chooses an action family, arguments, duration, and stop decision;
- **success/value head** that estimates verifier success and remaining cost;
- **uncertainty head** that can halt instead of emitting an unsupported action;
- **state-consistency decoder** used during training to reconstruct the minimum observation facts required for the next action.

No pretrained transformer, language model, vision model, embedding table, adapter, tokenizer model, or external policy is permitted.

## Teacher trace reduction

Authorized teachers generate complete verified executions. A deterministic reducer converts each execution into:

```text
request_digest
initial_observation
[observation_t, action_t, action_result_t, verifier_delta_t, value_t]*
terminal_observation
terminal_verifier_bundle
artifact_or_world_digest
teacher_lineage
```

The reducer removes:

- hidden reasoning;
- conversational filler;
- redundant tool narration;
- provider-specific syntax;
- unverified intermediate claims;
- actions that had no causal effect on the verified result.

The retained sequence is therefore an observation/action/value program grounded in actual state changes.

## Direct action vocabulary

The action space is not a generic tool registry. It is a fixed, compiled actuator vocabulary owned by the deployed environment, for example:

```text
MOVE_POINTER(x, y)
PRESS(keycode)
TYPE_BYTES(offset, length)
WRITE_REGION(target, offset, length)
SELECT_OBJECT(object_id)
COMMIT_TRANSITION()
STOP(success_estimate)
```

Arguments are emitted by neural heads, not serialized as natural-language tool calls. The device runtime only decodes and applies the action packet. It performs no planning, model inference, search, or semantic interpretation.

This distinction is mandatory:

```text
forbidden: model -> prose/tool call -> agent/tool executor
allowed:   student policy -> bounded action packet -> actuator
```

## Training objective

The student is trained with a mixed offline control objective:

```text
L = L_action_bc
  + lambda_state * L_latent_dynamics
  + lambda_value * L_return
  + lambda_adv * L_verified_advantage
  + lambda_fail * L_failed_branch
  + lambda_obs * L_minimal_observation_reconstruction
  + lambda_stop * L_calibrated_stop
  + lambda_budget * L_action_compute_budget
```

Where:

- `L_action_bc` imitates verified teacher actions;
- `L_latent_dynamics` predicts the next recurrent state after an action result;
- `L_return` predicts terminal verifier value;
- `L_verified_advantage` upweights actions that causally improved verifier state;
- `L_failed_branch` contrasts failed actions with repaired descendants at the first divergence;
- `L_minimal_observation_reconstruction` prevents latent-state collapse while discouraging transcript memorization;
- `L_calibrated_stop` teaches the controller to stop only when success is sufficiently supported;
- `L_action_compute_budget` penalizes unnecessary actions, active state, and recurrent depth.

Optional later stages may add verifier-gated offline reinforcement learning, but no live self-modification or uncontrolled environment exploration is admitted by default.

## Alienware self-relay

The Alienware worker trains the controller as its own continuing neural lineage.

A sealed outbound-polled capsule contains:

- exact repository commit;
- random-generation-zero seed or parent student checkpoint digest;
- full student architecture manifest;
- observation and action schemas;
- verified reduced trajectories;
- optimizer and scheduler state;
- curriculum position;
- frozen evaluation episodes;
- required parent and output digests.

The worker verifies the capsule, resumes the student's complete neural and optimizer state, trains on local CUDA, evaluates in a deterministic sandbox, and returns a signed successor checkpoint and evidence bundle.

There is no borrowed root checkpoint. Generation zero starts randomly; generation N+1 descends only from generation N. The Alienware machine is therefore not adapting somebody else's model. It is carrying the student's own nervous system forward.

## Curriculum

1. observation encoding and action syntax;
2. one-step verified state changes;
3. short closed-loop tasks;
4. persistent-state tasks with hidden information revealed over time;
5. failed-versus-repaired causal forks;
6. long-horizon action compression;
7. held-out requests and state layouts;
8. interruption and exact checkpoint resume;
9. quantized local execution;
10. physical-device shadow evaluation before any authority-bearing deployment.

## Deployment contract

The admitted deployment graph must remain:

```text
bounded observations
  -> local neural controller
  -> bounded action packet
  -> deterministic actuator
  -> next bounded observation
```

It may not contain:

- a foundation model;
- remote inference;
- an assistant or agent subprocess;
- a planner;
- a generic tool selector;
- natural-language action interpretation;
- retrieval used as a hidden policy;
- runtime gradient updates;
- unrestricted shell, network, or authority access.

## Required evidence

A valid run returns:

- proof of random generation-zero initialization;
- proof that no pretrained tensors were loaded;
- capsule, parent, and successor checkpoint digests;
- exact observation and actuator schemas;
- trace-reduction receipts binding teacher executions to reduced trajectories;
- CUDA identity and measured GPU-seconds;
- changed tensor digests;
- optimizer and recurrent-state continuity across resume;
- held-out closed-loop success;
- verifier-value calibration;
- action count and latency distributions;
- unseen-layout and unseen-lineage transfer;
- quantized retention;
- deterministic replay receipts;
- independent reproduction and human admission.

## Falsification gates

Reject or redesign the lane when:

- behavior cloning succeeds only on exact layouts;
- the recurrent state memorizes trajectories rather than tracking world state;
- compounding action error prevents long-horizon completion;
- value estimates are not calibrated enough to support safe stopping;
- reduced traces omit information required for successful action;
- the controller requires natural-language planning at deployment;
- a generic tool or agent loop reappears under another name;
- training compute exceeds the adapted language-model lanes without a strict latency, memory, autonomy, or energy advantage;
- quantization breaks closed-loop stability.

## Relationship to the rootless artifact-native student

The artifact-native student emits a canonical artifact representation that a deterministic compiler converts into bytes. This lane is more direct: it learns the closed-loop policy and emits environment actions itself.

```text
artifact-native lane: request -> neural student -> artifact IR -> compiler

direct-action lane:   observations -> neural student -> action packet -> actuator -> observations
```

The direct-action lane is therefore appropriate only where the observation and actuator boundary can be tightly specified, simulated, verified, and authority-limited.

## Truth boundary

This document defines an experimental architecture and evidence contract. It does not prove that rootless direct-action training will scale, generalize, remain stable over long horizons, or outperform a language-model controller. Teacher traces are still generated using external intelligence during dataset construction. "No tooling" applies to learned planning and inference at deployment; a deterministic bounded actuator is still necessary to turn an action packet into a state transition. No capability or production claim is permitted before real training and all gates pass.
