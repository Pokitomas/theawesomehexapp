# Why bigger Archie route models plateau

The 12-route governed router holds ~75/80 on the Q6 admission suite and ~0.75 on
the 498-prompt heldout across every width tried (512 / 768 / 1024). Scaling did
not move it. This is the honest investigation into why, run against the specific
hypotheses raised in review. All numbers are from `foundry/archie-protocol`
training on the audit corpus (seed 3407 unless noted).

## Method

- **(A) seed variance** at hidden=768, epochs=110, five seeds.
- **(B) shared-failure test**: train hidden ∈ {256, 512, 1024} (seed 3407),
  compare the *set* of misclassified cases on the 60-case
  `router-real-v2-heldout` suite.
- **(C) regime**: hidden=1024 (seed 3407) under four learning-rate / epoch
  schedules.

(An earlier pass accidentally omitted the seed argument in one script,
degenerating the RNG to a constant and producing symmetric near-chance models;
those numbers were discarded. Two independent seeded runs agree on the figures
below — at epochs 110 all three widths miss the *same* 22 cases, intersection =
union = 22.)

## Findings, per hypothesis

**"The three-point differences are random seed noise."** — **Confirmed.**
At fixed width=768, 498-heldout accuracy over five seeds was
0.747 / 0.741 / 0.747 / 0.747 / 0.745 (mean 0.7454, **sd 0.0023**, range 0.006 ≈
3 prompts of 498). The 512→768→1024 spread (0.751 / 0.747 / 0.749) is *smaller*
than the within-width seed spread. Width differences are noise.

**"The shared 0.6333 score reflects a fixed failure mode none of the widths
solved."** — **Confirmed.** On the 60-case suite (seed 3407, epochs 90), widths
256 / 512 / 1024 score 0.617 / 0.633 / 0.617 and make 23 / 22 / 23 errors. Of
those, **22 are made by all three widths** — the union of all misses across
widths is only **23**. Widening 256→1024 changes exactly one case. The residual
errors are the *same cases* regardless of capacity: the weakest routes on this
suite are plan, objective, checklist and message (2/5 each), while decision
(5/5), next_action, compound, summary and clarify (4/5) hold. The 60-case suite
uses a conversational register the training corpus under-covers, so the plateau
is a **train/eval distribution effect that width cannot touch**, not a capacity
limit.

**"The task has a ceiling near 0.75."** — **Partly true, for this router.** The
80-case head-to-head caps at 75/80 because the remaining five are
context-dependent (attached-file / memory) cases a **text-only bag-of-features
router structurally cannot see**. That is a real ceiling for this input
representation, not for the task in principle.

**"The dataset is too small or repetitive."** — **Contributing.** 925 rows,
with ~150 synthesized compound conjunctions built by templating — repetitive by
construction. Raising caps to 1035 rows slightly *hurt* the 498-heldout
(0.751→0.743), i.e. more of the same distribution did not help and mild
overweighting hurt. The corpus lacks the 60-case suite's register entirely.

**"The evaluation set is too small."** — **True and material.** The 60-case
suite makes each example worth 1.67%; 0.6333 is 38/60. Confidence intervals at
n=60 are ±~12 points, so single-model comparisons there are underpowered — which
is exactly why (B) compares *miss sets*, not scores.

**"Training duration or learning rate is mismatched for larger models."** —
**Not the bottleneck (measured).** hidden=1024 under four schedules
(lr/epochs = 0.08/110, 0.05/160, 0.12/90, 0.03/220) gave 498-heldout
0.749 / 0.745 / 0.757 / 0.743 and 60-case 0.633 / 0.633 / 0.617 / 0.633. The
best 498 score (0.757 at lr=0.12) still left the 60-case suite on its plateau.
No schedule lifts the fixed failure set.

**"The architecture lacks depth, attention, memory, or useful inductive
structure."** — **True, and the real lever.** The model is a one-hidden-layer
MLP over a bag of word / bigram / char-trigram features. It has **no word order
beyond bigrams, no attention, no memory of prior turns, and no access to
attached artifacts**. The failures that survive every width — context-dependent
routing and register shift — are precisely what such a representation cannot
capture. The productive next step is *structure* (order-aware encoder, turn/file
context), not *more parameters* on the same bag-of-features.

## Conclusion

Scaling parameters was the wrong axis: the residual error is **shared across
widths, stable across seeds, and concentrated in a distribution the corpus never
contained**. Bigger nets were shipped (up to 4.24M) because the review asked for
bigger and they cost nothing in quality, but the receipts say plainly that the
gain was ~0. The honest path forward is corpus coverage of the missing register
and an order/context-aware architecture — not width.
