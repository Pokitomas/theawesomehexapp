# Archie local language-core receipt

## Decision

Do not treat a slightly wider version of the current route classifier as the next product breakthrough.

The observed plateau can plausibly combine several effects:

- the training corpus is small and contains repeated templates;
- a small evaluation set makes three-point differences unstable;
- duration and learning-rate choices may not transfer cleanly to wider models;
- the current feature-hashed perceptron has no native turn memory, attachment representation, authority state, or structured multi-output decoding;
- some task slices may have a practical ceiling near the observed range without new information;
- seed variation can be as large as width variation;
- repeated scores can reflect a shared failure mode that added width does not solve.

Those hypotheses do not prove the trained router is useless. They mean parameter count alone is weak evidence. Archie therefore retains the admitted trained router as a task-mode candidate and adds a narrow local language layer around the systematic misses.

## Intervention

`mind-core.mjs` adds deterministic, inspectable handling for:

- ordered clauses and multiple requested outcomes;
- explicit output requests and negated output types;
- previous-turn and active-objective references stored on the device;
- readable local text attachments plus honest metadata-only fallback for unsupported files;
- abstention on vague or ungrounded source input;
- authority boundaries against fabricated completion, credential capture, and ambiguous destructive requests.

`archie.js` adds browser speech recognition when available, speech synthesis, local file attachment controls, structured receipts, and truthful separation between neural routing evidence and deterministic response generation.

## Boundary

This is not an LLM and does not claim open-ended language understanding. It is a trained narrow router plus a deterministic local language core. It performs no external action, makes no network inference request, and does not claim that an action occurred unless the page has evidence for it.

## Checks

- `node --check archie/archie.js`
- `node --test archie/mind-core.test.mjs`
- `scripts/tests/archie-phone-product.test.mjs` now verifies voice/file wiring, offline caching, ordered multi-outcome behavior, negation, thread context, readable attachments, and authority abstention.
