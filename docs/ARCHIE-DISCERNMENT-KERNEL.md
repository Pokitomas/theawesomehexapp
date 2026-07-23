# Archie Discernment Kernel

This is the campaign logic that should survive the operator or coding agent that invented a particular run.

## Purpose

Archie should not become "better" by consuming more fabricated tasks. It should choose real experience well, change how it learns when evidence identifies a failure mode, preserve useful capabilities, and promote only a candidate that improves on untouched history.

## Laws

1. **Reality before narration.** Prefer committed states, human intentions, actual patches, execution receipts, sensor bytes, and observed outcomes. Generated examples are an explicit minority lane, never an invisible default.
2. **A lesson needs alternatives.** Pair one observed state with its real successor and a plausible wrong successor drawn unchanged from another real event.
3. **Credit the decision.** Shared formatting and context are not causal evidence. Preference gradients begin at the first divergent target byte.
4. **The student spends the budget.** Score a bounded real subset, replay according to surprise, causal confusion, and learning progress, and reserve a fixed exploration share for unseen evidence.
5. **Measure time, not shuffled fragments.** Keep whole commit groups together. Tune on older held-out history and open the newest history once.
6. **Every failure changes the method.** More patch likelihood with worse causal choice means change the objective, not merely train longer. Better causality with worse generation means isolate the causal delta and search weight space.
7. **No metric laundering.** A candidate cannot trade away patch likelihood, causal margin, or pair accuracy on the selection gate. If no candidate clears all three, retain the baseline.
8. **Weights are material.** Preserve base, specialist, rejected, and merged hashes. A specialist can be valuable as a task vector even when its endpoint is not promotable.
9. **Compute must survive interruption.** Save model, optimizer, scheduler, RNG, and curiosity state atomically. Resume exact lineage; never restart an expensive round because a terminal disappeared.
10. **Stop is an intelligent action.** If objective repair and bounded weight search fail, stop consuming compute and redesign the observation or credit assignment.

## Dynamic response table

| Evidence | Next move |
| --- | --- |
| Patch loss improves; causal metrics regress | Preserve the model as a generative base. Train a divergence-only specialist from it. |
| Causal metrics improve; patch loss regresses | Treat the specialist delta as a task vector. Run nested temporal merge search. |
| Both regress | Reject immediately. Change representation, negative construction, or observation boundaries. |
| Both improve on selection | Freeze the exact candidate and evaluate once on newer history. |
| Selection improves; newest history regresses | Reject. The selection rule overfit. |
| All final gates improve | Promote as a research candidate, then run public-corpus retention, plasticity, and execution evaluations. |

## Current evidence

The raw real-history round improved unseen patch likelihood strongly but reduced causal discrimination. A stronger whole-patch preference round regressed both and was rejected. Divergence-only teaching produced a useful causal task vector but was not itself promotable. A temporally nested line search selected alpha `0.9`; on 103 newer untouched episodes it improved patch loss by `0.009630` nats/token, mean causal advantage by `0.015727`, and pair accuracy by `0.048544` over the preserved base.

This is evidence of repository-transition learning, not general intelligence. The public-corpus falsifier then measured a `17.99%` relative bits-per-byte regression, so the checkpoint is a task specialist rather than a generally promoted model. Plastic transfer remained positive in 9 of 12 cases but averaged only `0.0539%`, far below the `3%` gate. The next valid action is a retention-aware task-vector merge against the public model, not additional gradient training.
