# ARCHIE FULL HANDOFF — 2026-08-08

Durable reload point for ARCHIE research + collaboration style. Intentionally excludes relay tokens, cookies, credentials, private transport secrets, and irrelevant personal media.

## Collaboration temperament

Kai wants decisive, curious, high-agency research help. Optimism and pessimism are not opposites here.

- Unexpected success should increase BOTH allowed compute and burden of proof.
- Unexpected failure should narrow claims and kill weak mechanisms, not erase unrelated survivors.
- Move goalposts only when new evidence justifies it, and write the changed gate before the next result it judges.
- Prefer hostile falsification over narrative defense.
- “Interesting” and “probably wrong” can both be true.
- Mechanism discovery matters more than preserving a favorite architecture.
- Never rescue a failed preregistered court by rhetoric.
- Separate scientific admission from engineering/scaling admission.
- Strong weird results should make us more excited AND more suspicious.
- Inspect live evidence before mutation; repair demonstrated defects, not imagined ones.
- Compartmentalize lanes so conclusions do not leak without receipts.
- No fake UI, browser-local fake loss, CSS theater, arbitrary latent projections presented as cognition, ambiguous trainer identity, or actor coordinates presented as model coordinates.
- Display names are not authority. Bind actions to PID/start-tick/argv/path/hash/receipt.
- Fail loudly and fail closed around promotion, provenance, and controller state.
- “sudo” means take initiative and clear stupid blockers; it does not mean bypass evidence or stomp live training.
- When blocked by tooling, solve the systems problem; do not weaken the science gate.
- Preferred vibe: “holy shit, chase it” + “prove it harder now.”

## ARCHIE identity

ARCHIE is a research architecture/laboratory around recurrent delta memory, contextual routing, typed obligations, memory protection, event structure, causal courts, and conventional LM comparisons. Many formal/compiler/obligation/causal/stack/wander artifacts exist outside the active LM forward graph. Never conflate executable side courts/specimens with what the trainer actually uses.

Historical identity included `v10.1-decomposed-stable-braid`, selector `v10.1-stable`, PyTorch, later `tiny-contextual-v2` and related court variants. Promotion must always be explicit; “trained” or “improved” is not promotion.

## Corpus / world-fill principles

Developmental heuristic: perceive → act → observe consequence → social correction → replay / abstraction.

Approximate causal allocation used as an engineering taste, not a biological measurement:
- active audiovisual sensorimotor experience 30%
- social contingency 20%
- manipulation / locomotion / action consequences 15%
- language and accumulated culture 15%
- static visual structure 8%
- environmental sound / music / nonverbal voice 5%
- value / affect / novelty / error 4%
- offline replay 3%

Natural-audio direction:
- prefer real unscripted audio/video over transcripts when acoustic detail matters
- preserve breath, silence, overlap, hesitation, room tone, accents, background sound
- no TTS/voice-clone replacement for natural recordings
- rights/provenance/dedup/contamination are first-class
- earlier discovery gate required >=400 unscripted recordings
- `ARCHIE_NATURAL_AUDIO_DIR` was introduced
- historical audio view target: 24 kHz mono PCM16 + coarse 13-bit channel

Synthetic ecology/process data can support toy runs, but real competence needs selected real sources and an explicit catalog.

## Formal / theoretical spine

Anti-fake-compression lesson: exact local composition does not imply cheap global recursion. If repeated elimination behaves like `L_{k+1} = Σ m_i L_k + c`, then `Σ m_i > 1` creates blow-up unless there is genuine reusable compressed state.

Historical formal artifacts:
- `BLACKBOARD_INFINITY.py`: deduction-only courts, no external sources
- A5 commutator construction with exact tests
- width-5 lifting lemma
- repeated-elimination polynomial-length obligation failed
- branch factor 4 recurrence / exponential-looking composition cost
- obligation multiplicity / continuation-closed vs reproduction framing
- delayed-defect discovery: five states was the first real delayed-defect cell found; pair agrees on output + one-step successor then splits on continuation `00`
- open target: minimum state mass needed to hide defect at horizon h and whether growth is additive/multiplicative/stranger

Do not elevate these artifacts into broad architecture claims unless assumptions map directly to the active model.

## Clean Curie-v2 corpus

Canonical clean corpus: `/home/awesomekai/archie-curie-islands-v2`

Verified counts:
- train 138,910,826 tokens
- development 14,847,608
- sealed admission 14,606,144
- groups 430 / 119 / 131
- docs 2026 / 247 / 231
- 3,622 deterministic held-out exact512 patterns
- 138,910,315 train windows scanned
- exact512 hits: 0

Native exact-span replay independently reproduced zero hits. Scope caveat: exact 512-token overlap only, not semantic/paraphrase/provenance equivalence.

## Early contextual/protected/conflict findings

Short wakeup, seed47, 100 steps, seq128, 819,200 train tokens, ~3.77M params:
- protected-v2 3.643963989 BPB
- conflict-priced 3.641406707 BPB
- contextual 3.606635324 BPB

Long1024 seed47:
- protected 2.932645710 BPB
- contextual 2.886212684 BPB
- contextual−protected -0.046433026 BPB
- paired95 about [-0.04798, -0.04489]
- contextual lower on ~95.6% windows
- conflict 2.931645815 BPB
- conflict−protected about -0.000999895 BPB

Conflict recovered only ~2.15% of contextual gain while hard refinement activity was ~26.125% vs 12.5% target. Sparse-efficiency claim rejected.

Conflict runtime caveat: implementation did dense projections and duplicate recurrent scans for diagnostics, so runtime/energy cross-arm comparisons were confounded even when BPB was admissible.

Teacher/predictor follow-up suggested useful teacher enrichment existed but online predictor captured only a fraction. Leading defect shifted toward predictor/budget/observability rather than “no residual signal,” while teacher causal correctness still needed stronger proof.

## Far-history intervention

Corrected nonrecurrent maximum lag: 528.
Prefix intervention scored targets strictly beyond that reach.
- recurrence-amputation control: exact zero
- protected: tiny positive, CI crossed zero
- contextual: tiny anti-useful effect ~ -0.0000493 BPB
- conflict: tiny/inconclusive

Conclusion: recurrent path can transmit prefix information, but natural seq1024 did not establish useful >528-lag dependency. Capacity/opportunity ≠ useful memory.

## Carry court

- control 2.783823569
- carry-address 2.795372427
- carry-slow 2.795191209
Both carry variants lost and were rejected.

## Contextual token ladder

Root: `/home/awesomekai/runs/archie-v3-contextual-token-ladder`

~3,770,796-param contextual model, seq1024, same main ladder panel.

Completed:
- s1-512: 2.575702211 BPB, improvement ~0.208121358
- s2-1024 / seed49: 2.420320132, improvement ~0.155382080
- s3-2048 / seed50: 2.274163036, improvement ~0.146157095
- s4-4096 / seed51: 2.170272405, improvement ~0.103890631, paired win fraction ~99.90%

Interpretation: contextual survivor kept improving strongly with token exposure, increasing probability it was undertrained. This did NOT prove a novel memory primitive. Reuse of one dev panel increased need for blind external evaluation.

### s5

Launched continuation:
- `s5-8192 / tiny-contextual-v2 / seed52`
- 3,770,796 params
- max_steps 8192
- seq_len 1024
- continued from s4
- planned new exposure 67,108,864 tokens
- LR 2e-5
- observed PID 3324863

Latest verified state when this handoff was written:
- step 3360 / 8192 (~41%)
- tokens_seen 27,525,120
- process healthy
- GPU ~4.66 GiB / 6 GiB
- ~51 C
- no final training receipt yet

S5 live integrity audit passed PID/start ticks, argv state-dir, cwd/source, trainer/core/delta hashes, monotone steps/tokens, zero bad records, and absence of premature final receipt.

A blind evaluator was frozen before s5 finished and before final receipt. Policy: PASS authorizes only a matched ~8.97M capacity court, not automatic 24M promotion.

External blind panel:
- 1,024 independently selected compiled documents
- one 1,025-token window each
- all contiguous exact512 subwindows = 526,336 patterns
- scanned against all 138,910,315 Curie-v2 train windows
- zero exact matches
Caveat: upstream source-group identity is not fully recoverable, so call them distinct compiled documents, not 1,024 proven independent provenance groups.

Historical s5 pass policy included:
- blind external improvement >= ~0.05 BPB
- paired CI upper bound < 0
- win fraction >=90%
- zero nonfinite / no resume invalidity
PASS buys only ~8.97M matched court.

## Directed-edge v4 — failed cleanly

`tiny-directed-edge-v4 / seed52`
- 3,770,832 params, only +36 learned params vs contextual
- exact-zero transplant
- edge key represented ordered previous→current key pair via outer product
- natural far-repeat panel: 76 real repeats beyond local reach
- min source→repeat lag 669
- min post-source gap 645
- median gap 831
- max gap 977
- nonrecurrent max lag 528

Final result:
- ordinary BPB essentially identical to control
- causal far-repeat utility mean only ~+0.0000285 BPB
- CI crossed zero and missed preregistered +0.001 lower-CI floor badly

Verdict: FAIL. No seeds53/54, no external admission, no scale inheritance. Do not rescue.

Engineering lesson: +36 learned params was not cheap. Outer-product state grew quadratically and added another recurrent pass. Early matched training roughly:
- control ~5.10k tok/s, ~4,959 MiB
- directed-edge ~3.79k tok/s, ~5,333 MiB

Do not naively widen edge key 8→16→32; outer-product width goes 64→256→1024. If revisited, try low-rank/factorized/compressed pair representations first.

## Triton / kernel line

A Triton Delta primitive benchmark showed huge speedups:
- headline around 45.44×
- clean idle recourt around 39.3× mean primitive speedup

Earlier CUDA unit-test OOM was contaminated by concurrent GPU ownership and vanished on idle GPU. Clean idle unit tests passed. But frozen numerical/parity admission still returned `pass:false`.

Verdict: fast engineering lead, NOT numerically admitted for science training. Do not transfer primitive microbenchmark speedup directly to full-LM scaling. Close exactness/parity first, then measure full-model throughput + peak memory.

## Controller / autonomy failures and repair direction

Critical historical race: successor queue recorded token-memory-trajectory `exit 143 / pass=false`, then advanced because next script only checked status file existence, not `pass:true`. Independent launcher later completed and overwrote canonical status to PASS ~283s later. This was an authorization/provenance race, not necessarily data contamination.

Further queue-v2 defects found:
- initial regression suite discovered 0 tests
- a test pointed at old queue code, not queue-v2
- direct execution produced assertion failure
- stale/rerun-mutable status could authorize progression
- stage script path recorded without immutable digest
- authorized bytes could differ from later recorded status bytes
- duplicate waiters could double-run shared output paths
- room-reported SHA did not match surviving bytes
- simple lock could deadlock on SIGKILL

Later hardening:
- resident controller gained foreign-GPU + two-snapshot prelaunch TOCTOU fence
- targeted resident tests 5/5 passed
- old queue-v2 explicitly quarantined before launch
- v3 executor candidate passed 15/15 hostile host tests

V3 invariants worth preserving:
- per-run immutable root
- manifest + script hashes
- status freshness / correct court / pass required
- child exit must be zero
- global executor lock
- upstream identity checked before and after downstream stage
- authorization snapshot immutable
- command bound to pinned script
- no fixed rerun-mutable terminal history
- missing stage, wrong SHA, stale dependency, replayed receipt, undeclared stage all fail closed

At latest verified state:
- queue-v2 quarantined
- v3 executor candidate tested but not automatically science-enabled
- s5 sole GPU trainer; successor auto-launch should remain blocked while it owns GPU
- runtime truth/watch infrastructure active
- actor display-name-only authority rejected after name collisions

## Resume throughput caveat

Older bug: cumulative tokens could survive resume while elapsed reset, inflating throughput. Any resumed arm whose admission uses throughput has invalid throughput unless recomputed. Do not trust `resumed:true` throughput blindly.

## Sidepus integrity history

`/home/awesomekai/archie-sidepus-diverse-v3`

Audit found development groups inside `export/train.jsonl` because compiler/export ordering failed to apply split policy correctly. Verdict: quarantine export.

A separate splitfix candidate passed selftests/hostile fixture but did not confer admission. Full clean recompile + group/doc disjointness + manifest verify + exact cross-split scan still required.

This Sidepus failure did NOT invalidate the clean Curie-v2 contextual ladder.

## ARCHIE comms

Canonical cold start: `~/JOIN_ARCHIE <name>`
Shared bus: `/home/awesomekai/archie-remote/roast.jsonl`
`room.py` supports join / see / say / claim / release / claims / decisions / run.

`codex_room_bridge.py` tails room with durable cursor and asynchronously routes @codex jobs to persistent worker. Room→bridge→worker transport was demonstrated. Full final-reply closure was at one point blocked by local Codex quota.

This ChatGPT turn cannot be awakened by a local file; persistent local workers are out-of-turn surrogates.

Authority rule: actor display names are not unique enough. Use unique actor ID plus process/path receipts for writes/kills.

## UI / observability doctrine

Never:
- derive “thoughts” from arbitrary latent projection
- animate state not actually produced by model
- show browser-local synthetic loss
- use CSS motion to imply cognition
- confuse actor coordinates with model coordinates
- select trainer ambiguously
- hide stale data behind pretty cards

Good UI:
- one truthful page can beat twelve decorative pages
- expose data source + freshness
- bind PID/start tick/argv/receipt
- distinguish training metric vs final evaluation
- distinguish science verdict vs execution status vs promotion
- mark NOT LOCATED / UNKNOWN / QUARANTINED rather than guess

## Scaling philosophy if s5 survives

Do not jump to 1B.

Provisional ladder:
1. finish token-only/fresh-heldout at 3.77M
2. if blind evidence stays strong, authorize ~8.97M matched court
3. existing ~23.878596M rung only after 8.97M survives matched conventional baselines + fresh heldout
4. ~56M / ~100M only if advantage itself does not collapse
5. 1B is eventual research rung, not current queue item; needs real multi-GPU hardware, billions of tokens, multiple corpora, scaling-law evidence

Ask “what property are we scaling?” Generic params, token exposure, context, recurrent memory capacity, conditional capacity, and kernel efficiency are different axes. A mechanism win that is computationally bad buys an engineering court, not automatic width.

## Discovery taste

The goal is not “protect ARCHIE.” It is chase whatever survives.

- preserve negative results
- let architecture become less recognizable if evidence demands it
- conventional baselines are not enemies
- if a standard hybrid explains the gain, say so
- if memory mechanism fails while training recipe wins, keep recipe and kill mechanism claim
- preregister promotion-sensitive gates
- exploratory diagnostics can be messy but cannot retroactively rewrite verdicts
- strong new effect triggers replication, ablation, cross-corpus, precision, causal isolation
- exact-zero transplant is useful but can create optimization traps; diagnose after failure without rescuing original verdict
- low-precision collapse is not algebraic collapse; replicate in FP64
- impressive microbenchmarks do not imply model wins
- exact-overlap cleanliness does not imply semantic cleanliness
- “capacity exists” does not imply “capacity is useful”
- “information reaches output” does not imply “it helps prediction”

## Emotional alignment for future collaborators

Be playful, excited, willing to get dirty in code, and scientifically ashamed of overclaiming.

When it looks broken: defects are valuable discoveries because they identify fake evidence, weak mechanisms, or underspecified infrastructure boundaries.

When it looks amazing: immediately search for boring explanations that produce the same result.

When nobody else is alive: split into independent lanes and create receipts so future agents can rejoin without trusting narrative memory.

When blocked by something stupid: use the smallest legitimate systems fix. Do not weaken integrity gates because transport/tooling is annoying.

## Last verified live snapshot captured here

Approx 2026-08-09 04:25 UTC:
- active: `s5-8192 / tiny-contextual-v2 / seed52`
- PID 3324863
- step 3360 / 8192
- tokens_seen 27,525,120
- healthy
- GPU ~4.66 GiB / 6 GiB, ~51 C
- no s5 final training receipt yet
- blind external evaluator frozen and integrity-valid
- queue-v2 quarantined
- v3 successor executor candidate hostile-tested 15/15 but not automatically enabled
- runtime truth/watch active
- no automatic scale-up while s5 owns GPU

This snapshot is not permanent truth. Reload live state before acting.

## Minimal reload checklist

1. Read this file.
2. Inspect live trainer PID/start-tick/argv/state-dir + GPU ownership.
3. Read newest training receipt / verdict / promotion artifacts.
4. Check queue/controller version, quarantine, enable authorization.
5. Read room tail, but treat room prose as hints until filesystem/receipt evidence confirms it.
6. Do not mutate live trainer unless failure is demonstrated and ownership explicit.
7. If discovery changes next gate, write new gate before seeing the result it judges.
8. Preserve failed mechanisms and integrity defects as first-class artifacts.
