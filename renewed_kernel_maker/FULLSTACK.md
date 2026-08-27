# ARCHIE FULLSTACK LOCAL MAKER

Canonical stack, top to bottom:

1. **Controller / seat membrane** — localhost controller owns continuity, provider-neutral seat, stale-basis refusal, receipts, replacement/yield semantics.
2. **Universal remote kernel** — capability registry + verified effects; adapters own platform details.
3. **Maker runtime** — generate -> inspect -> build -> test -> run -> repair -> benchmark. No app is promoted because it merely exists.
4. **Application family** — generated apps share one project/receipt contract. Current reference apps are ARCHIE CUT and ARCHIE VOXEL.
5. **IDE / orchestration shell** — project graph, files, tests, terminal commands, preview/runtime, benchmark evidence, model prompt/response trajectory, replay.
6. **Local model runtime** — source model adapter -> tokenizer/context adapter -> inference backend -> tool protocol -> maker policy. The runtime may be llama.cpp, vLLM, Transformers, or a future backend; the maker contract does not depend on one provider.
7. **Corpus foundry** — manifest-driven acquisition, license/provenance metadata, normalization, deduplication, contamination filtering, task synthesis, train/validation/heldout shards, deterministic hashes.
8. **Teacher / sourcing layer** — every candidate teacher is represented by a model card describing weights access, architecture, context, tool-use suitability, local resource cost, legal/source provenance, and observable transfer surfaces. Ox/Alpha is represented as GLM-5.3-Flash only where proven.
9. **Distillation layer** — behavioral trajectories first; logits/hidden-state transfer only where legitimately observable. Architecture similarity is measured, never asserted. Large-teacher execution may be remote/offline while student training remains local.
10. **Synthetic curriculum** — generated programming/game/editor tasks, adversarial repairs, preference pairs, deterministic graders, heldout task families, anti-leakage receipts.
11. **Trainer** — SFT / ranking / preference optimization / optional representation or logit losses. Triton is an optimization backend only after a reference implementation passes numerical equivalence.
12. **Evaluation courts** — cold start, receipts, seat takeover, app-maker repair, generated-app integration, voxel-game build/play invariants, video edit/render, heldout maker success, tool trajectory consistency, contamination/no-leakage, model/resource honesty.
13. **Promotion** — only evidence from the courts may advance the resident state.

## Local-model end condition

A local model is considered a useful maker only when, from a text game brief and the same public tool contract used by the controller, it can create a new directory containing a complete voxel game, run the build/tests, repair failures without hand-edited code, launch the result locally, and emit a deterministic project receipt. The benchmark uses held-out briefs and fresh seeds. A prewritten voxel template by itself does not satisfy this condition; it is only the reference target and grader substrate.

## Voxel game reference contract

`archie-voxel-project/v1` requires: generated procedural chunk terrain, first-person camera, keyboard movement, pointer-lock mouse look, gravity/jump, collision with the voxel field, block remove/place interaction, hotbar/material selection, save/load world state, deterministic world seed, no network dependency, and a measurable frame/update benchmark. The minimal distributable target is a static HTML/JS app requiring no package install; richer native/WebGPU targets may be generated later.

## Corpus policy

The foundry may index very large corpora, but every record keeps `source`, `license`, `sha256`, `split`, and contamination tags. Sources can include permissively licensed code, project docs, compiler/test traces, synthetic tasks, public model-generated teacher trajectories when use is permitted, and the user's own project history. Secret/private data is not silently swept into training. Benchmark prompts and heldout seeds are never admitted to training shards.

## Coherence rule

There is one project graph, one receipt format, one capability membrane, one corpus manifest format, and one promotion court. Backends and models are replaceable pipes.