# Manual studio

This is the editable product layer for `/manual/`.

The large ingestion and ranking core is still assembled from the repository's verified overlays. Do not hand-edit generated or packed shards. Product work belongs here:

- `product/copy.js` — visible product language and onboarding copy.
- `product/studio.css` — visual tokens, layout, mobile behavior, and the bold skin.
- `product/studio.js` — small DOM enhancements that do not fork the core application.
- `apply.py` — idempotently installs this layer into the assembled `manual-app/`.
- `verify.py` — rejects malformed UTF-8, binary control bytes, syntax errors, and accidental removal of phone-test contracts.

## Build contract

After the normal overlays have produced `manual-app/`:

```bash
python studio/manual/apply.py
python studio/manual/verify.py
```

The Pages and phone-proof workflows run those commands before copying or testing the manual product.

## Compatibility contract

Keep these phone-test labels stable unless the test changes in the same commit:

`ADD`, `KEEP`, `READ`, `SEND`, `FILES +`

Keep these DOM hooks stable:

`#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`

The root saturation kernel remains generated from the root feed. The studio layer can change the product shell aggressively, but it must not duplicate or rewrite that math.
