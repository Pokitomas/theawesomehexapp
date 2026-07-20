# Archie mastery run — 2026-07-20

This directory preserves the Linux-only research result from starting commit `2dc828454fe4dc27478d5172f560e645bf0bf249` and exact audit SHA-256 `a190c28ceeb6292ae6857a6e885ec32810cf16737ad950826bfc70531d48bc15`.

## Decision

**Not admitted. Production and deployment are unchanged.** The strongest trained candidate learned transferable structure but did not retain every capability supplied by the deterministic register projection.

| Router | Original 498 | Real v2 60 | Real v3 48 | Suite 80 | Independent 160 |
|---|---:|---:|---:|---:|---:|
| Base neural router | 477 | 56 | 26 | 59 | 95 |
| Deterministic projection | 498 | 60 | 48 | 75 | 95 |
| Strongest trained student | 476 | 56 | 31 | 59 | 104 |
| Student + strict learned verifier | 477 | 56 | 26 | 59 | 95 |

The student is a compact one-layer, 48-dimensional Transformer state encoder pretrained locally with masked-token prediction over training-side text, followed by a multi-head correction network over order-aware states, base-router state, and explicit diagnostic channels. It repairs five hard-register cases and gains nine independent mechanism cases, but creates retention regressions.

## What was mastered

The decisive mechanism is the separation of **representation**, **structural judgments**, and **trusted support**. Order-aware pretraining improves semantic transfer. Auxiliary context, authority, outcome-count, and mode labels are learnable. However, neither soft fusion, hard hierarchy, global thresholds, pairwise thresholds, seed consensus, nor a separately learned abstention verifier can determine when those judgments are safe on the frozen distribution using the available supervision.

The independent suite also shows that the current projection does not generalize: it scores exactly the same as the base router (`95/160`). The trained student reaches `104/160`, proving learned transferable structure exists, but not yet with the retention required for shipment.

## Reproduction boundary

No OpenAI API or external teacher was used. All training and evaluation ran locally on Linux. Frozen prompts were excluded from corpus generation, tokenizer fitting, masked-language pretraining, route training, verifier training, and threshold selection. The exact audit archive is identified above. The missing large training payloads documented in `mastery-report.json` were not reconstructed or guessed.

Run `python tests/verify_evidence.py` from this directory to verify artifact digests and the non-admission gate.
