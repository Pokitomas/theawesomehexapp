# Archie’s mind: current reality and Generation One target

Archie is already a model system, but it is not yet a frontier generative model.

That distinction matters. Calling the current backend “just a cache” is inaccurate; calling it frontier-equivalent would also be inaccurate. The current system learns and generalizes over plans, relations, confidence, failures, and execution evidence. It does not yet learn a broad probability model of language and the world from a substantive pretraining corpus.

## What thinks today

The active cognition path is an evidence-gated ensemble.

### 1. Sparse learned skill mixture

Successful and negative Maker traces become examples. Archie hashes task and context tokens into a fixed-width sparse representation, applies corpus-derived weighting, compares the request with learned specialists, and retrieves a prototype only when confidence and separation thresholds are satisfied.

This is learned statistical inference. It is not exact string matching, but its semantic range is bounded by its representation and corpus.

### 2. Calibrated action planner

Archie learns reusable tool/action transitions from prior trajectories and composes candidate plans. Positive outcomes raise support; failed, rejected, unsafe, denied, and cancelled outcomes become negative knowledge. Calibration determines whether a proposed route is strong enough to be considered locally.

### 3. Proof-carrying relational derivation

A separate model abstracts entities, clauses, operators, dependencies, and control language. It can derive a plan from relations rather than requiring one previously observed sentence. The resulting plan carries grounding and derivation evidence.

### 4. Consensus and uncertainty controller

The sparse model, calibrated planner, and relational derivation model do not receive unrestricted authority. Archie compares their outputs and executes locally only when agreement, grounding, instruction control, and calibrated confidence clear declared gates. Otherwise it escalates.

### 5. Teacher distillation

Unresolved tasks can route to a stronger teacher under a budget controller. The resulting trace is retained only through the learning pipeline, including negative outcomes. Later evaluation measures whether the teacher interaction became a locally owned capability.

### 6. Evidence-bound execution

Planning authority and effect authority remain separate. Maker is the permissioned effect executor. Exact verified recurrences can receive stronger automation; novel actions remain bounded by grants, verification, and launch policy.

## The honest current description

> Archie is an evidence-gated, teacher-distilled local planning model with sparse retrieval, calibrated action composition, relational derivation, negative memory, uncertainty control, and verified execution recurrence.

That is a legitimate model. Its learned parameters and structured state influence new outputs. It is different from a transformer language model because its primary learned objects are plans, transitions, relations, confidence, and execution evidence rather than a broad next-token/world model.

## Current ceiling

Archie does not yet have enough evidence to claim any of the following:

- broad generative world modeling;
- frontier language or reasoning equivalence;
- a substantive independently curated pretraining corpus;
- a trained local neural student admitted on held-out capability gates;
- reliable long-horizon latent state across arbitrary domains;
- autonomous architecture superiority;
- safe general external-write authority.

The runtime, trajectory recorder, distillation pipeline, student admission gates, device evidence, and launch frontier are infrastructure for those claims. They are not substitutes for the trained checkpoint and its evaluations.

## Generation One mind

The strongest target preserves the current symbolic/statistical system and adds a neural student rather than deleting what already works.

### Generative base

A compact local language/world model proposes interpretations, intermediate representations, plans, explanations, and recovery options. Sidepus diet manifests and admitted trajectory batches bind its training data to exact provenance.

### Tool and action heads

Maker traces train tool selection, argument construction, dependency planning, verification prediction, correction, rollback, and stop behavior. Failed and rejected traces remain explicit negative knowledge rather than disappearing from the corpus.

### Retrieval and episodic memory

Immutable receipts, evidence graphs, owned skills, and prior outcomes provide retrieval-grounded context. Retrieval state is mutable learned state with its own digest, not an untracked side channel.

### Verifier and value model

A separate learned component predicts plan validity, expected capability gain, risk, uncertainty, and whether escalation is preferable. Held-out verification receipts—not the student’s own confidence—control promotion.

### Existing symbolic control layer

Archie Language, the evidence compiler, sparse skill mixture, calibrated planner, relational derivation, authority grants, and Maker execution remain interpretable constraints and fallbacks. The neural model proposes; the control layer decomposes and constrains; the verifier judges; Maker acts; receipts determine what may be learned.

## New hard contracts

`foundry/archie-neural/archie-trajectory.mjs` defines provenance-bound trajectories and admission receipts.

A positive trajectory is not admitted merely because a run says “completed.” It requires exact request binding, base/head/patch provenance, passed verification, and at least one independent verifier. Failed work may be admitted as negative knowledge when its evidence is intact. Rejected trajectories remain visible in the batch receipt.

`foundry/archie-neural/archie-model-contract.mjs` composes with the existing signed `archie-model-manifest/v1` runtime.

It separates immutable architecture, axioms, authority, state schema, and allowed learning operations from mutable parameters, sparse state, graph state, routing weights, action transitions, uncertainty calibration, negative lessons, episodic memory, and retrieval indexes. A checkpoint can load only when:

- the existing runtime has verified and trusted the signed manifest;
- model identity, version, runtime ABI, and manifest digest match;
- immutable and mutable state digests match the manifest;
- held-out benchmark receipts exist;
- the checkpoint has not been rejected.

## What “frontier” means here

Frontier is an empirical launch state, not an architecture adjective. Archie reaches it only when an exact model/checkpoint/hardware/runtime combination passes the declared held-out intelligence, tool-use, reliability, safety, latency, continuity, cost, and embodiment gates. A constrained fallback cannot overwrite the strongest truthful default claim, and a strong architecture cannot overwrite missing measurements.

## Next implementation frontier

The next decisive tranche is not another planner wrapper. It is:

1. compile Sidepus diet manifests and provenance-bound Archie trajectory batches into a reproducible training run;
2. train or continue-pretrain the first local neural student;
3. emit a checkpoint bound to the existing signed runtime manifest and the new state contract;
4. run hidden held-out capability, procedural, safety, retention, adaptation, cost, latency, and device evaluations;
5. admit or reject the checkpoint without moving the goalposts;
6. route admitted neural proposals through the existing symbolic control and Maker authority layers.

Until that checkpoint exists and passes, Archie should be described proudly and precisely as a learned evidence-gated planning model—not dismissed as a cache and not marketed as a frontier model.
