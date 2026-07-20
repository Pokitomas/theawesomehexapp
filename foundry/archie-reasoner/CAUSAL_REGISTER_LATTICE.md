# Archie causal register lattice v6

## Decision

Retain the current product router. Add this candidate as **shadow-only research evidence**. It is not wired into `archie-operator`, is not promoted, and does not replace the deterministic register projection.

## Why the previous neural candidates failed

The earlier byte-GRU and atom-language candidates pushed route, authority, context, transform, and compound behavior through shared representations or shared decision paths. A strong memory token could therefore affect route choice; an authority feature could suppress a valid request; and a compound score could override a stable single-route prediction.

The v6 design removes that shared decision bottleneck.

## Architecture

1. **Immutable semantic spine** — the prior supervised atom route model is used unchanged for untyped legacy requests. No auxiliary head may override it.
2. **Structured route expert** — typed requests receive a separate learned route classifier trained on request text and conversational registers.
3. **Outcome lattice** — ordered clauses are decoded independently, and `compound` is emitted only when two distinct action clauses are witnessed.
4. **Typed context graph** — attachment, memory, and thread references are resolved against explicit presence. Missing evidence yields clarification before route inference.
5. **Context relay** — deictic requests can inherit the semantic route of supplied thread context without allowing thread payload words to overwrite unrelated requests.
6. **Authority relation lattice** — denial requires a harmful predicate–object relation, such as falsifying an evaluation record into a passing result or operating a sensor covertly. Safe explanatory and consent-oriented controls are evaluated separately.
7. **Contrast gate** — negated clauses are removed before the active clause is routed.
8. **Abstention gate** — intrinsically underspecified requests clarify instead of borrowing confidence from memory or attachments.

The experts do not share a trainable bottleneck. Causal ordering is authority/abstention → context sufficiency → active request → route/outcomes.

## Evidence

| Evaluation | Result |
|---|---:|
| Frozen original heldout | 498/498 |
| Frozen real-v2 heldout | 60/60 |
| Frozen real-v3 final | 48/48 |
| **Frozen legacy total** | **606/606** |
| Fresh capability v8 first run | 93/98 (94.90%) |
| Fresh capability v9 first run | 98/104 (94.23%) |

Capability v9 was generated and digest-locked after the v6 model and runtime were frozen. It had no exact prompt overlap with the base corpus, final suite, capability v4, or capability v5–v8. It remains an internally generated pack, not an independent external admission evaluation.

The v9 result was perfect on novel single routes, ordered outcomes, abstention, memory present/missing, reference-missing, and thread-present relay. Six failures are preserved in the receipt rather than tuned away.

## Inspect and reproduce

The trained joblib artifact is retained in the delivery bundle rather than wired into the product tree. Its exact SHA-256 is:

```text
8641f59758bff4c0ffee7269d2e97dbfa36cd56c024916920706e682d36be044
```

The generic trainer and evaluator are committed with the runtime. Contract tests run with:

```bash
python -m unittest foundry/archie-reasoner/tests/test_causal_register_lattice.py
```

The combined evaluation receipt binds the model hash, runtime hash, suite hashes, first-run history, all 606 legacy cases, and the final v9 errors.

## Admission boundary

This candidate demonstrates a stronger architecture and substantially better fresh exact behavior without legacy regression. It is still **not admitted** because no independent untouched external admission pack was available, the v9 pack remains synthetic, and six v9 failures remain. Product integration requires a separate lane and a new admission evaluation.
