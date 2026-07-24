# Sidepus evidence islands

## Decision

A causal model evaluated on the same experience plan it trained against still cannot distinguish mechanism learning from plan memorization. Sidepus therefore partitions experience before sampling or materialization into three immutable evidence islands:

- **train** — the only inventory from which pursuit and sequential-control training plans may be built;
- **development** — a disjoint court that fixes checkpoint identity without touching admission;
- **admission** — an untouched final court shared by pursuit and the matched sequential control.

## Island identity

Records are connected into one indivisible island when they share either:

- an explicit sequence, episode, thread, trajectory, or conversation identity; or
- a model-visible object digest rare enough to identify a particular experience lineage.

Very common model-visible digests are reported as shared primitives rather than used as identity edges. This prevents a common delimiter, schema object, or reusable asset from collapsing the complete inventory into one island.

The split receipt requires zero cross-split overlap for:

- record IDs;
- explicit lineage identities;
- identifying model-visible object digests.

All model-visible digest overlap is also reported so common shared primitives remain visible rather than silently ignored.

## Execution

The campaign constructs the compiled inventory once, splits it once, and then seals three independent plans. Pursuit and sequential-control arms receive the same train plan, model initialization, optimizer settings, update count, retention corpus, and admission court. Their only intended difference is experience selection within the common training reservoir.

For each arm, both the final checkpoint and the trainer's internal best checkpoint are judged on development evidence. A deterministic development score fixes one selected checkpoint and writes a selection receipt. Only that selected checkpoint may enter admission. Admission never chooses a model.

The development and admission evaluators measure:

- correct state versus reset state;
- correct state versus a verified state from a different evidence lineage;
- world-only and plastic-only ablations;
- token-level loss at every deliberation depth;
- loss-plus-compute oracle depth;
- dynamic halt choice and expected depth;
- compute-adjusted gain over forced depth one and forced maximum depth;
- halt/oracle agreement and halt regret;
- language-retention regression against the source shell.

The final verdict asks whether pursuit beats the matched sequential control on the same untouched admission plan while correct state remains useful and adaptive computation pays for its cost.

## Interpretation

A passing admission verdict is not model admission. It establishes one bounded result:

> On one disjoint evidence split, active pursuit produced a better candidate than matched sequential experience, and the candidate's correct persistent state plus dynamically allocated causal thought contributed measurable value.

Independent split seeds, independent training seeds, external task families, hardware accounting, and replication remain mandatory before a broader capability claim.

A failing verdict is retained as evidence. The launcher completes and writes the court receipts rather than hiding a negative result behind a failed shell command.

## One-command profiles

The smoke profile performs a fresh 100-step pursuit arm, a matched 100-step sequential-control arm, development checkpoint selection, untouched admission evaluation, and the final verdict.

The full profile expands training to 30,000 steps and remains inappropriate until the smoke receipts are inspected. Smoke and full use separate default state, cache, and export roots so one profile cannot silently resume or overwrite the other.
