# Manual studio

This is the editable product layer for `/manual/`.

The large ingestion and ranking core is assembled from the repository's verified overlays. Do not hand-edit generated or packed shards. Product work belongs here:

- `product/copy.js` — every visible product phrase, onboarding message, and storage label.
- `product/studio.css` — visual tokens, card language, navigation, and the bold base skin.
- `product/studio-components.css` — onboarding, imports, storage, progress states, accessibility, and responsive components.
- `product/studio.js` — idempotent product behavior layered over the canonical application.
- `apply.py` — installs the editable layer into the assembled `manual-app/` without duplicating tags.
- `verify.py` — rejects malformed UTF-8, binary bytes, syntax errors, render-loop regressions, missing assets, and broken phone-test contracts.

## Build contract

After the normal overlays have produced `manual-app/`:

```bash
python studio/manual/apply.py
python studio/manual/verify.py
```

The Pages and phone-proof workflows run both commands before copying, testing, or deploying the manual product.

## Editing the product

Change language in `copy.js`. Change the shared palette, borders, shadows, navigation, and cards in `studio.css`. Change onboarding/import/storage/mobile components in `studio-components.css`. Change additive product behavior in `studio.js`.

Keep enhancements idempotent: check whether text, attributes, or components already match before writing to the DOM. The verifier enforces the scheduled enhancement contract because an unbounded mutation loop can block the feed's animation and ranking loop.

## Compatibility contract

Keep these phone-test labels stable unless the test changes atomically in the same commit:

`ADD`, `KEEP`, `READ`, `SEND`, `FILES +`

Keep these DOM hooks stable:

`#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`

The root saturation kernel remains generated from the root feed. The studio layer can change the product shell aggressively, but it must not duplicate or rewrite that math.
