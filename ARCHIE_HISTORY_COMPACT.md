# ARCHIE compact historical knowledge

Purpose: preserve the useful engineering/scientific history in one place while implementation sprawl is removed. This file is a memory aid, not a source of truth for live runtime state. Current claims must still bind executable source, configuration, receipts, and evaluation results.

## Current identity boundary

The current Aug-8 laboratory identity is the typed-Delta line observed outside this stale GitHub tree:

`archie_lab_train.py -> archie_lab_core.py -> typed_delta_memory.py`

Recorded Aug-8 source hashes:

- trainer: `4235f2fcbbfd1f1e490cae9a564c515ded9f9daa1c61e65a13244f9be33ff34e`
- core: `53714ea61d56aad72646c32d53163eee54ab402b108e9958962e702ed188f0dd`

Do not infer current model identity from old QLoRA, SSM, architecture-campaign, protocol, or product files.

## Live laboratory results retained

### Triton backend

A clean-idle recourt showed the frozen Triton implementation remained extremely fast at the tested benchmark shape (`batch=8, heads=6, length=1024, key=8, value=32`):

- candidate: `2.405 ms/step`
- reference: `94.513 ms/step`
- mean speedup: `39.31x`
- unit tests: `5/5` passed
- repeatability: exact across three runs
- forward parity: passed
- maximum observed gradient absolute error: `0.00061035`
- gradient admission: failed
- admission status: not admitted

Interpretation: the speed result is alive and the implementation remains worth work. The blocker is numerical gradient fidelity under the stricter benchmark gate, not performance collapse.

### tiny-directed-edge-v4

Observed arm:

- seed: `52`
- parameters: `3,770,832`
- far-repeat causal utility: `+0.0000285 BPB`
- 95% CI: `[-0.0001046, +0.0001616]`
- required lower bound: `+0.001 BPB`
- result: rejected

No downstream seed53/54 or external admission was established at the time this result was recorded.

## Transport/runtime history

The Vercel relay process remained alive while transport visibility regressed.

Observed failure modes:

- production `/api/relay` continued returning successful responses
- newest deployment dropped or broke `/api/join` and returned `404`
- `/api/voice` produced `502`
- one root proxy path returned upstream connection refused
- a prior deployment still contained `/api/join`

Interpretation: these are transport regressions. They are not evidence that the model, trainer, or evaluation controller itself died.

Preserve the outbound runner / lease / event-chain transport files until the bridge is replaced by a smaller proven path. Similar names do not imply model membership.

## Major retired implementation findings

### Selective-SSM hybrid lane

The old `SelectiveStateSpace.forward` implemented the recurrence using a cumulative product followed by a floor before division:

`prefix = cumprod(a).clamp_min(1e-20)`

then accumulated `b / prefix`.

This changes the recurrence once the true prefix falls below the floor. Example:

- recurrence: `state_t = 0.1 * state_(t-1) + 1`
- correct state after long enough: about `1.111111`
- old parallel scan around token 64: about `45.1111`

With decay `0.01`, the old path produced about `55.01` instead of about `1.01`.

This is an algorithmic error, not ordinary floating-point drift.

The associated contract test only checked finite forward/backward behavior and did not compare the parallel scan to the defining sequential recurrence.

The old trainer also retained cumulative `tokens_seen` on resume while resetting elapsed runtime and `skipped_nonfinite_steps`, making resumed throughput and cleanliness receipts non-cumulative.

These defects were localized to the retired hybrid SSM line and must not be projected onto typed Delta without direct evidence.

### Causal-divergence QLoRA lane

Useful engineering ideas retained:

- bind failed trajectories to independently verified repairs before using them as training evidence
- apply preference pressure after the first real chosen/rejected divergence rather than over the shared prefix
- keep strict precision in numerical/evaluation lanes
- fail closed when CUDA/NF4 requirements are not actually met

Historical truth boundary for that lane stated that the method existed but no admitted CUDA-trained artifact or capability result was established.

A stale-contract mismatch was found between the workflow test's expected baseline commit and the committed request file. This was another reason not to preserve the lane as current machinery.

### RSLoRA / segmented distillation lane

Useful standalone ideas retained:

- keep repair lineages atomic while sharding
- balance shards by estimated replay/attention work rather than raw pair count
- cache frozen-reference scores only when bound to exact checkpoint, tokenizer, pair bytes, and replay policy
- fuse LoRA deltas, not LoRA factors
- exact fusion can be represented by concatenating A rank blocks and weighted/scaled B rank blocks so the resulting delta equals the weighted sum of source deltas
- when RSLoRA source scaling has already been absorbed into B, the fused adapter should use unit ordinary-LoRA scaling to avoid scaling twice
- resume evidence should bind model/adapter, optimizer, scheduler, RNG, scaler, trainer state, and exact input/software identities
- recursive training should reopen from concrete evaluator failures rather than synthetic failure invention

The lane was retired because it was not on the current typed-Delta execution path and its workflows depended on already-retired causal-divergence components.

## Historical real CPU RSLoRA evidence

These were real optimizer updates but were explicitly noncanonical and not admitted.

### lite-0.6b

- model: Qwen3-0.6B
- precision/device: CPU FP32
- RSLoRA: rank 16 / alpha 32
- trainable parameters: `4,587,520`
- optimizer steps: `8`
- runtime: `70.5417 s`
- peak RSS: `5,028,356,096 B`
- held-out accuracy: `0.25 -> 0.25`
- mean pair margin: `-6.10213 -> -1.95556`
- margin delta: `+4.14657`
- adapter SHA-256: `7cc3ca6d62fbc6ae6e93272c518944731629eea1b52180138c09b01773016618`

### deep-0.6b

- model: Qwen3-0.6B
- CPU FP32
- same rank/alpha and trainable count
- optimizer steps: `32`
- runtime: `125.1884 s`
- peak RSS: `5,059,674,112 B`
- held-out accuracy: `0.25 -> 0.50`
- mean pair margin: `-6.10217 -> +4.33932`
- margin delta: `+10.44148`
- adapter SHA-256: `a4656284823296f872122a09d86e3bbb485fb5d20b6e641ef01a10ec99969a76`

### target-1.7b-fast

- model: exact pinned Qwen3-1.7B revision `8d4744f9e13072f4920c326350fa81eedb74eae9`
- CPU BF16
- RSLoRA rank 4 / alpha 8 on `q_proj,v_proj`
- trainable parameters: `802,816`
- optimizer steps: `1`
- runtime: `30.7232 s`
- peak RSS: `4,939,075,584 B`
- one held-out pair accuracy: `0 -> 0`
- mean pair margin: `-9.34475 -> -9.05729`
- margin delta: `+0.287458`
- nonzero adapter tensors: `112`, including `56` nonzero LoRA-B tensors
- adapter SHA-256: `0523fdad350180e1aa5c365eaf8f852e3aa85febe012ef92e172ba11aa8b5a63`

These runs prove bounded CPU gradient updates and held-out movement only. They do not establish CUDA/NF4 parity, canonical information-budgeted training, fused-candidate gain, quantization retention, broad capability, reproduction, or admission.

## Court IV / event-semidirect result retained as research history

A historical event-semidirect model audit found the solver exponent problem being tested did not apply because the recurrence was structurally affine (`beta = 0` in that analysis).

The more important discovered bottleneck was that retention and noncommutative transport shared one normalization budget. Historical measured examples included:

- target horizon 32: shipped transport range about `4.9%`
- target horizon 128: shipped transport range about `0.95%`
- full-transport effective horizon about `2.1 tokens`
- initial slowest-fiber half-life about `34 tokens`
- retained signal over 512 tokens about `3.3e-5`
- `1/lambda_min = 500 < 512`, so no fiber spanned the full training window under that setup

A proposed scale-free transport form `tau_i = kappa * lambda_i` without the old denominator produced a near-fiber-independent worst-case prefix norm spread of about `1.03x` at `kappa=1.0` while preserving the slowest fiber's roughly 500-token horizon.

This is research history for a different model line, not evidence about current typed Delta unless rederived there.

## Formal/math findings worth retaining

### Delayed-defect cells

A five-state construction was identified as the first useful delayed-defect cell in that line of work: a pair can agree on output and one-step successors yet split only on continuation `00`.

Useful open target: characterize the minimum state mass required to hide a defect until horizon `h`, then determine whether the growth law is additive, multiplicative, or another recurrence. This may become a memory lower-bound route if formalized.

### Obligation/work growth

Historical formal audits emphasized that exact local reuse does not imply cheap global recursion. A recurring diagnostic recurrence was:

`L_(k+1) = sum_i m_i L_k + c`

If `sum_i m_i > 1`, repeated exact elimination can blow up even when each local step is simple.

A concrete audited example used branch factor 4 and constant instruction cost 5:

`L_k = 4^k L_0 + 5(4^k - 1)/3`

The failed obligation in that audit was polynomial repeated-elimination length.

Practical ARCHIE implication: use explicit evidence stores, typed obligation graphs, context-bound cache keys, and measured work/span/memory/replay rather than assuming recursion compresses itself.

### A5 commutator artifact

Historical exact work included an A5 construction with:

- group size `60`
- twelve disjoint 5-cycles
- 13-block motif
- 52-block commutator identity
- 100% match on 1,000 tests for the recorded identity
- a width-5 lifting lemma
- recurrence `L_(d+1)=4 L_d`
- resulting `O(4^d)` construction with `d=O(log n)` in that setup

Treat this as formal artifact history, not automatically as a current architecture primitive.

## Numerical precision policy

For normal training, lower precision and TF32 may be fine when empirically validated.

For near-singular, cancellation-sensitive, quaternion, Heisenberg, HRT-adjacent, parity, or degeneracy evaluation:

- include an FP64 reference when practical
- include strict FP32 reference
- disable TF32 in the reference lane
- report smallest singular value where relevant
- report condition number where relevant
- report forward and gradient absolute/relative error separately
- repeat runs to detect nondeterministic numerical instability
- do not infer physical or mathematical claims from numerical cancellation alone

The HRT/quaternion idea is useful here as a warning about precision sensitivity, not as proof that ARCHIE has a hidden mathematical phenomenon.

## Model design history worth remembering

A later ARCHIE design direction included:

- remove compulsory global tanh/decay from recurrent state
- addressed erasure of the form `E = I - beta k k^T`, `0 <= beta <= 1`
- two-quaternion transport `q_L v conjugate(q_R)`
- hierarchical chunk scan
- scan-closed feedback only
- 4x4 matrix memory with addressed erase/write
- unified scan monoid carrying affine/erase/write effects
- staged obligation fields for protected memory
- hybrid local-attention + recurrent stack
- BF16 token compute with FP32 recurrent state
- long warmup

These are design-history constraints, not a statement that all are present in the current typed-Delta source.

## Development/data philosophy retained

Historical corpus work converged on a few stable principles:

- active audiovisual/sensorimotor and social contingency should not be treated as equivalent to passive text volume
- speech/audio data should preserve timing, breath, silence, overlap, hesitation, accent, room tone, and nonverbal vocal information where rights permit
- synthetic ecology is useful for plumbing but must not masquerade as real-world evidence
- rights/provenance audits and exact source identity belong in the training boundary
- evaluation should report competence directly rather than infer it from corpus size or training completion

## Repository simplification rule

Before deleting a candidate file/family:

1. read the exact content;
2. check direct references/imports/workflow references;
3. classify as current dependency, current evaluation, unique evidence, duplicate, or dead;
4. preserve unique quantitative results, hashes, falsifiers, or useful algorithms in a compact evidence/history file;
5. delete duplicate/dead implementation scaffolding;
6. do not preserve a family solely because its name sounds current.

Naming collisions already proved this rule matters: old model files and current transport files both used words such as `hybrid` but served unrelated purposes.

## Language policy

Use mechanism-first terms in active engineering prose:

- evaluation gate
- worker/process
- permission scope
- admission status
- explicit failure
- monitoring/telemetry
- exposed interface
- numerical cancellation
- near-degenerate state
- condition number
- singular value
- precision sensitivity

Keep old wire/schema/path identifiers unchanged when compatibility requires them.

## What is not established

As of this compact history:

- no GitHub-era historical candidate is automatically canonical
- no broad intelligence claim is established by these artifacts
- no historical speed result alone establishes numerical correctness
- no numerical cancellation result establishes HRT or a physical interpretation
- no transport failure establishes that the trainer/model died
- no completed training run establishes admission without the declared evaluation and reproduction gates

The useful operating principle is simple: keep the smallest executable current path, preserve exact negative/positive evidence, and make every new claim bind the actual source, configuration, environment, and receipt that produced it.
