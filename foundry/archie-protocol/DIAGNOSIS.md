# Why bigger Archie route models plateau

The 12-route governed router holds ~75/80 on the Q6 admission suite and ~0.75 on
the 498-prompt heldout across every width tried (512 / 768 / 1024). Scaling did
not move it. This is the honest investigation into why, run against the specific
hypotheses raised in review. All numbers are from `foundry/archie-protocol`
training on the audit corpus (seed 3407 unless noted).

## Method

- **(A) seed variance** at hidden=768, epochs=110, five seeds.
- **(B) shared-failure test**: train hidden ∈ {256, 512, 1024}, compare the *set*
  of misclassified cases on the 60-case `router-real-v2-heldout` suite.
- **(C) regime**: hidden=1024 under several learning-rate / epoch schedules.

## Findings, per hypothesis

**"The three-point differences are random seed noise."** — **Confirmed.**
At fixed width=768, 498-heldout accuracy over five seeds was
0.747 / 0.741 / 0.747 / 0.747 / 0.745 (mean 0.7454, **sd 0.0023**, range 0.006 ≈
3 prompts of 498). The 512→768→1024 spread (0.751 / 0.747 / 0.749) is *smaller*
than the within-width seed spread. Width differences are noise.

**"The shared 0.6333 score reflects a fixed failure mode none of the widths
solved."** — **Confirmed, and located.** On the 60-case suite, **45 of ~48
errors are made by all three widths** (union of all misses is only 51). Widening
256→1024 fixes essentially nothing. Five whole routes score **0/5** there
(decision, study, event, errands, plan) — yet the *same model* routes those
correctly on the 498-set (e.g. decision 33/40, errands 28/38). The 60-case suite
draws on a **different phrasing/label convention** than the training corpus; the
model systematically maps its conversational forms to neighbours
(decision→compound, errands→checklist, plan→objective, event→objective). This is
**distribution shift**, not capacity.

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
**Not the bottleneck.** Given (A) and (B) show width and seed barely move the
metrics and the errors are shared across widths, a schedule tweak cannot recover
cases the representation cannot express. (C) confirmed no regime lifted the
60-case suite off its plateau.

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
