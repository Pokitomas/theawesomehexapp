# ARCHIE Research Horizon — 2026-08-11

## Governing ambition

The ambition is **not a breakthrough**. A breakthrough is an intermediate checkpoint.

The persistent loop is:

**discover → derive → build → falsify → benchmark → integrate → replace the current best → repeat**

No architecture, training rule, parameterization, statefulness/attention split, memory representation, optimizer, compiler path, or framework is sacred. PyTorch is a tool, not a boundary. If a useful hypothesis cannot be represented cleanly in the standard stack, build the smallest lower-level runtime/kernel/court needed to test it.

Prefer attempts with plausible **orders-of-magnitude** upside over endless 5–20% polishing, while requiring exact evidence before promotion.

Research claims must be labeled as one of:
- direct machine observation;
- theorem / mathematical consequence;
- deterministic deduction;
- statistical inference;
- hypothesis;
- user directive.

A seductive impossibility claim is not a roadmap. Prove the boundary first, then attack the nearest lawful formulation.

---

## Current backend state — fresh bounded-EXEC watch

The forgotten live door was recovered. The correct bounded surface is:

`HTTPS → Vercel /api/relay → route=exec → ARCHIE EXEC`

`route=cmd` was the wrong door for the current executive surface. A fresh `help` call returned HTTP 200 and identified the bounded/no-shell surface with verbs including `say`, `hear`, `status`, `watch`, `read`, `crawl`, `journal`, `alarms`, and `ledger`. A PATIENT `watch` job was admitted and drained successfully, so the following state is direct machine-derived evidence rather than stale summary.

Fresh watch at approximately 00:09 local:
- GPU: `2645 / 6144 MiB`, utilization `8%`, temperature `39 C`.
- Canonical trainer identity: **STALE**.
- Truth age: `21366.4 s`.
- Executive verdict: **FAIL-CLOSED: do not infer one trainer**.
- No alarm was raised by the watch job.
- Therefore GPU occupancy is real, but it is not currently lawful to attribute that occupancy to one named trainer without a fresh identity receipt.

Matched 24,140,160-parameter arms reported by the live dashboard:
- ARM T `small-xf`: 12 attention / 0 SSM, DONE, `1.160768 bpb`, step `6000/6000`, last shown loss `0.7040`, NaN 0, skipped 0.
- ARM H `small`: 3 attention + 9 SSM, DONE, `1.164678 bpb`, step `6000/6000`, last shown loss `0.6951`, NaN 0, skipped 0.
- ARM H2 `small-mem`: long-memory init, DONE, `1.166176 bpb`, step `6000/6000`, last shown loss `0.6947`, NaN 0, skipped 0.

Identical-batch hybrid-minus-transformer sample-efficiency trajectory:
- 3.7M tokens: `-0.2663`, 95% CI `[-0.3800, -0.1554]` → hybrid better.
- 10.6M: `+0.0944`, CI `[+0.0749, +0.1139]` → transformer better.
- 17.6M: `+0.0202`, CI `[+0.0096, +0.0304]` → transformer better.
- 24.6M: `-0.0002`, CI `[-0.0124, +0.0091]` → unresolved.
- 31.5M: `+0.0034`, CI `[-0.0011, +0.0078]` → unresolved.
- 38.5M: `-0.0096`, CI `[-0.0148, -0.0047]` → hybrid better.
- 45.9M: `-0.0060`, CI `[-0.0119, -0.0002]` → hybrid better.
- Dashboard verdict: **UNRESOLVED**, reported slope `+0.056/doubling`.
- This court is explicitly sample-efficiency, not compute-efficiency.

Rank-ladder snapshot, three seeds each where complete, paired against coeff-1536:
- `ctx1024-fibers256`: `0/3` complete.
- `ctx512-fibers256`: `3/3`, mean `2.940092`, delta `+0.174746` (worse).
- `ctx512-fibers320`: `3/3`, mean `2.914847`, delta `+0.149501` (worse).
- `rank-192`: `3/3`, mean `2.618228`, delta `-0.147119` (better).
- `rank-24`: `3/3`, mean `2.846150`, delta `+0.080804` (worse).
- `rank-96`: `3/3`, mean `2.691364`, delta `-0.073982` (better).
- `rotcap-0.01`: `3/3`, mean `2.953264`, delta `+0.187917` (worse).

Queue snapshot:
- `queue_after_armh.sh`: not running.
- Historical queue annotation still reads `ARM H → ARM H2 (small-mem) → rank-24 → ctx512/ctx1024 fibers`.

Interpretation for next work:
1. Do **not** infer that packed-stream-v1 or any other named trainer currently owns the GPU.
2. The active matched-arm results say architecture ordering is non-monotonic across token budget; no simple “hybrid wins” or “transformer wins” claim is admitted.
3. Rank-192 and rank-96 are the strongest currently displayed rank-ladder directions; rank-24 and the shown fiber/rotcap variants are negative controls worth preserving.
4. The queue is idle, so new experiments should be launched only after a fresh ownership/lease identity court, not by assuming the old queue is authoritative.
5. The bounded EXEC path itself is live and should be preferred over shell/legacy routes.

Historical packed-stream evidence that remains valid as archived evidence, not current process identity:
- Durable AMP-overflow recovery commit: `dc4500c349094f585ad561875fc44045403194af`.
- GitHub Actions run `31564020037`: success, including the explicit Packed-stream AMP overflow recovery court.
- Packed-stream patched source SHA: `e1df47d70ef18d1a3e1d0512e3deaaf2502c1b32190a3b4a6640de1da8a1d039`.
- Step 4017 batch `afaf8c3f1e245d80` reproduced as recoverable AMP overflow; scaler `262144 → 131072`; same batch retried and training continued.
- Original halt evidence was archived rather than deleted.

Durable coordination/evidence paths:
- `/home/awesomekai/archie-remote/ROOM.md`
- `/home/awesomekai/archie-remote/roast.jsonl`
- `/home/awesomekai/.archie-shell-sidecar.log`
- `/home/awesomekai/maximal/ACTIVE_GPU_LEASE.json`
- `/home/awesomekai/maximal/scratch/packed-stream-v1/receipts.jsonl`

---

## Frontier problem 1 — sub-quadratic long-context representation

### User target
Find a mathematical replacement for self-attention/KV growth that preserves fine-grained associative recall without O(N) resident context state.

### Hard boundary
A finite-precision, fixed-size state cannot losslessly encode an arbitrarily long, unrestricted token stream and later return every historical token exactly: there are more possible histories than finite states. Any proposal claiming exact arbitrary recall over unbounded input with truly fixed finite state must expose where information is stored (external memory, growing precision, bounded-entropy assumptions, recomputation, or loss).

### Researchable formulation
Attack the strongest lawful versions instead:

1. **Near-lossless recurrence under structured/low-entropy streams.**
2. **Fixed hot state + sparse external cold store**, where the recurrent state learns exact addresses rather than carrying full content.
3. **Invertible/group-valued carriers** that preserve transformations without accumulation drift.
4. **Hierarchical associative memory** whose resident state grows sublinearly and whose retrieval cost is sparse.
5. **Event-driven memory allocation**: repeated/predictable material never enters expensive memory; novelty does.

Candidate mathematical objects include monomial/group carriers, reversible operators, structured permutations, sparse address maps, product-code memories, and algebraic indexing. Non-commutativity is useful only if it buys measurable capacity/retrieval properties; it is not a virtue by itself.

### Falsification court
Adversarial random-token recall must sit beside natural-language benchmarks. Measure:
- exact-recall rate;
- bits of resident state per recoverable source bit;
- retrieval FLOPs;
- update FLOPs;
- long-horizon drift;
- latency;
- state growth with context.

No “infinite exact recall from finite finite-precision state” claim survives without an information-accounting proof.

---

## Frontier problem 2 — dynamic gradient flow / continuous adaptation

### User target
Replace global backpropagation/Adam-style state with asynchronous local learning that can adapt continuously on constrained hardware without catastrophic forgetting.

### Hard boundary
General exact backprop-equivalent credit assignment with zero retained information is not free: dependencies must be represented somewhere. Likewise, eliminating optimizer state does not eliminate the information needed to determine useful parameter updates.

### Researchable formulation
Pursue:
- local eligibility traces;
- forward-mode / perturbation credit;
- reversible activation reconstruction;
- sparse parameter-touch updates;
- low-rank or factored optimizer state;
- per-module learned update rules;
- predictive-coding / equilibrium-style local errors;
- event-triggered updates only on novelty;
- replay-free consolidation with explicit interference courts.

The win condition is not “different from Adam.” It is a superior memory × compute × stability frontier.

### Falsification court
Matched-token comparisons against AdamW/SGD:
- optimizer bytes per trainable parameter;
- activation bytes per token;
- wall-clock tokens/s;
- held-out loss/quality;
- forgetting on prior tasks;
- recovery after distribution shift;
- sensitivity to update order.

---

## Frontier problem 3 — memory bandwidth / compute-density wall

### User target
Stop spending most of the machine budget moving weights and state. Seek sub-byte representations and execution that increase useful arithmetic per byte.

### Sharpened formulation
“Zero decompression latency” is not assumed. A representation wins only when the **fused execution path** is faster end-to-end.

Attack:
- binary / ternary / 2-bit weight paths;
- bit-serial dot products;
- structured codebooks;
- product/vector quantization with fused LUT kernels;
- block-sparse + quantized layouts;
- monomial/permutation carriers that replace multiplies with indexed moves/signs/scales;
- topology-aware packing aligned to warp/tensor-core access;
- state layouts that avoid round-tripping through large dense tensors.

### Hardware court
On the actual RTX 2060, record:
- HBM/VRAM bytes read and written where measurable;
- kernel duration;
- achieved occupancy;
- arithmetic intensity;
- end-to-end step time;
- quality at matched tokens;
- compile overhead;
- peak VRAM.

Compression without wall-clock speed is not a win. Kernel microbench speed without full-step speed is not a win.

---

## Frontier problem 4 — autonomous self-verification / reasoning grounding

### User target
Prevent recursive self-improvement from amplifying hallucinations or silently degrading itself.

### Hard boundary
There is no universal terminating verifier for arbitrary programs/propositions, and unrestricted natural-language truth cannot be compiled into a complete formal proof system.

### Researchable formulation
Build **proof-carrying bounded action**:
- typed claims;
- explicit preconditions/postconditions;
- executable unit/integration courts;
- theorem proving where the domain is formalizable;
- sandboxed counterexample search;
- deterministic artifact hashes;
- rollback receipts;
- held-out evaluators;
- mutation-specific adversarial tests.

Any self-modification candidate must ship with the court intended to kill it.

The system may update research candidates, but no candidate becomes resident/admitted merely because it generated a convincing rationale.

---

## New lane — cerebellar novelty gating

Source inspiration:
**“Cerebellum-inspired memtransistors enable emergent differentiation for hardware-efficient novelty detection”** (Nature Communications, July 2026)
https://www.nature.com/articles/s41467-026-75212-4

### Transfer the mechanism, not the material
The software hypothesis is a pair (or small bank) of cheap asymmetric dynamical traces:
- an excitatory-like response;
- an inhibitory-like response;
- different update/decay/adaptation constants;
- novelty = transient disagreement / differentiation between them.

Repeated/predictable structure should increasingly cancel. Unexpected structure should generate a strong transient.

### What novelty can gate
Use the signal to selectively spend:
- attention/refinement;
- persistent-memory writes;
- retrieval;
- recurrent-state expansion;
- action-learning updates;
- corpus-crawler depth;
- verifier effort.

This creates a possible **compute-on-surprise** architecture: common structure gets cheaper as it becomes predictable; only unresolved novelty recruits expensive machinery.

### Minimal equations to test
For input feature `x_t`:

`e_t = alpha_e * e_{t-1} + beta_e * phi_e(x_t)`

`i_t = alpha_i * i_{t-1} + beta_i * phi_i(x_t)`

`n_t = norm(g_e(e_t) - g_i(i_t))`

Then gate expensive compute with a differentiable or discrete policy based on `n_t`, while separately tracking whether adaptation causes novel-but-recurring hazards to disappear too early.

No claim that these exact equations reproduce the device. They are a software abstraction of the opposing-timescale differentiation principle.

### Courts
1. repeated motif → novelty decays;
2. single perturbation → sharp transient;
3. novel event after long repetition → high recall;
4. recurring important anomaly → adaptation must not erase required detection;
5. adversarial high-frequency noise → bounded false positive compute;
6. matched-quality sequence task → activated FLOPs and wall time must fall.

---

## Orders-of-magnitude experiment portfolio

Do not wait for one grand architecture. Run independent killable experiments.

### A. Surprise-gated expensive compute
Baseline: every token invokes expensive lane.

Targets:
- **10× fewer expensive-lane invocations** at <1% degradation on task metric;
- stretch: **100×** on highly repetitive streams;
- report actual wall-clock, not only theoretical FLOPs.

### B. Associative memory accounting
Compare:
- attention/KV;
- recurrent state;
- structured group/monomial carriers;
- sparse external address store;
- novelty-gated memory allocation.

Target:
- **10× lower hot-state bytes** at matched retrieval accuracy;
- explicitly expose cold-store growth.

### C. Optimizer-state elimination
Compare AdamW against SGD, factored state, low-rank state, and local/eligibility candidates.

Targets:
- **4×–10× optimizer-state reduction**;
- no catastrophic quality collapse;
- faster or equal wall-clock adaptation.

### D. Bit-level / structured execution
Prototype the smallest kernels that can disprove the idea.

Targets:
- **≥3× end-to-end full-step speedup** before spending time on broad integration;
- stretch **10×** if memory traffic is truly dominant.

### E. Proof-carrying mutation loop
Every architecture mutation emits:
- hypothesis;
- expected win magnitude;
- cheapest falsifier;
- counterexample found;
- exact code hash;
- benchmark receipt;
- rollback path.

Target: dramatically increase **experiments rejected per hour** as well as wins per hour. Fast falsification is a capability.

---

## Research discipline

1. Preserve a known-good resident path while experiments mutate around it.
2. Never let “novel” mean “unmeasured.”
3. Do not optimize only scalar loss; inspect tensor/state/gradient geometry where useful.
4. Do not preserve PyTorch abstractions when they block the experiment; preserve correctness courts instead.
5. Do not preserve a new algebra because it is elegant; preserve it only if it wins.
6. Treat 2M tokens/s or any other extreme throughput number as a target to decompose into physical lower bounds, not a number to role-play.
7. Separate compute throughput, semantic quality, memory capacity, adaptation speed, and resident interaction latency.
8. A breakthrough is a checkpoint. The stopping condition is a system that keeps discovering, falsifying, integrating, benchmarking, and replacing its own best research candidates under durable evidence.
