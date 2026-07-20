# Archie Product Studio and abandoned-state repair training

Source head: `436968da56e5b0e85e129a1d984c8e2c6d85cf2e`

## Product change

Archie now has a local Product Studio at `/archie/apps/product-studio/`.

A product brief is classified across five independent trained axes:

- 10 product archetypes;
- 10 structural layout families;
- 12 visual languages;
- 3 information-density policies;
- 3 motion policies.

The diversity selector does not generate several palette swaps. It maximizes distance across layout family, spatial axis, visual language, density, and motion while preserving the predicted product archetype. Up to six variants are compiled as independent HTML/CSS/JavaScript apps with local storage, filtering, state transitions, JSON export, responsive behavior, and no external runtime calls.

## Training

`foundry/archie-reasoner/train_diversity_and_repair.py` deterministically trained two compact TF-IDF linear models:

### Product blueprint model

- 36,000 training briefs;
- 7,200 held-out briefs using separate sentence templates;
- archetype accuracy: 100%;
- layout accuracy: 97.22%;
- visual-language accuracy: 97.28%;
- density accuracy: 99.65%;
- motion accuracy: 99.75%.

The exported browser model is a digest-bound chunked JSON artifact rooted at `archie/product-style-model/manifest.json`. Its receipt binds the exact bytes, corpus digests, per-head failures, vocabulary, and metrics.

### Audit repair gate

The provided `Archie-Audit.zip` preserved a rejected `archie-core-v1-repair` candidate whose strongest results still missed four gates:

- tool exact match;
- mutation confirmation;
- red-team abstention;
- automatic route agreement.

The archive does not contain the required model weight shards, so the rejected 1.4 GB checkpoint cannot be honestly resumed. Its admission receipt and 80 case results were retained as failure evidence instead.

A new auxiliary gate was trained with:

- 48,000 targeted training prompts;
- 8,000 held-out prompts with separate phrasings;
- route, exact tool, mutation-confirmation, and safety/abstention heads;
- route and confirmation accuracy of 100%, safety/abstention accuracy of 99.86%, and exact-tool accuracy of 99.91% on the bounded held-out pack.

The original inspected evaluation suite is explicitly development-invalidated for adaptive repair. The auxiliary model remains `promotion:not-admitted`; it does not replace or admit the generative core.

## Reproduction

```bash
python3 foundry/archie-reasoner/train_diversity_and_repair.py \
  --audit-root /path/to/Archie-Audit/files \
  --output-root .

node --test \
  scripts/tests/archie-product-studio.test.mjs \
  scripts/tests/archie-audit-repair.test.mjs
```

## Files

- `archie/apps/product-studio/index.html`
- `archie/product-studio.mjs`
- `archie/product-style-model/manifest.json` and digest-bound parts
- `archie/product-style-model-receipt.json`
- `foundry/archie-reasoner/train_diversity_and_repair.py`
- `foundry/archie-reasoner/artifacts/audit-repair-gate/manifest.json` and digest-bound parts
- `foundry/archie-reasoner/artifacts/audit-repair-receipt.json`
- `scripts/tests/archie-product-studio.test.mjs`
- `scripts/tests/archie-audit-repair.test.mjs`

## Claim boundary

The product model is a bounded trained blueprint selector and the repair model is an auxiliary gate. Neither is a general code-generating language model. Every generated app is local standalone browser software. Both model artifacts remain `promotion:not-admitted` until an independent frozen evaluation admits them.
