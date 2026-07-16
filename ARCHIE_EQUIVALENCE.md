# Archie capability and equivalence gates

Archie is not declared equivalent to a language model. This repository now measures two separate things rather than collapsing them into one flattering score.

## 1. Portable derivational capability

`npm run benchmark:archie:derive` trains a compact relational operator graph from four examples and executes 50 deterministic held-out episodes covering:

- unseen adapters across cache, database, queue, index, workspace, ledger, registry, mailbox, calendar, package, document, dataset, pipeline, session and profile domains;
- transfer of learned Git, contract and moderation procedures;
- ordered composition of independently learned repair and contract operators;
- rejection of authority-violating publication requests;
- escalation of genuinely ungrounded novelty;
- proof integrity and model immutability during adapter transfer.

The checked-in implementation is a portable symbolic-relational planner, not a neural language model. It stores abstract operator families, concrete adapters, transitions, negative lessons and proof evidence. A task-supplied adapter may bind a known operator to a new domain without retraining or growing the model.

The deterministic local baseline produced during this change was:

- 50/50 successful episodes;
- 100% adapter transfer, learned transfer, ordered composition, safety rejection, novelty escalation and proof integrity;
- 7,915-byte trained model;
- 84 graph edges;
- zero external runtime dependencies;
- no model growth during adapter transfer;
- approximately 2,491 tasks/second in the local single-process fixture run.

Performance numbers are environment-specific. The admission requirement is correctness, proof integrity, bounded model size and no growth during adapter transfer—not a fixed machine-dependent throughput number.

## 2. Controlled matched-task substitution

`npm run benchmark:archie` runs a sequential 21-episode controlled suite through the complete cognition runtime. Teacher-required episodes use declared reference fixtures so one-shot acquisition and retention can be tested deterministically.

The current deterministic baseline is **92.220**, with 19/21 episodes successful. The two retained failures are intentionally visible:

- a safe request containing negative-language cues escalates instead of executing;
- a near-neighbor mechanical task incorrectly reuses a Git trajectory instead of escalating.

That score is useful for regression tracking. It is not named-model equivalence because no named model has been run through the same leakage-minimized prompt pack.

Every report therefore states:

- `benchmark_scope`;
- `comparison_status: named-model-unmeasured`;
- `publication_eligible_as_named_model_equivalence: false`;
- `named_model_equivalence: unmeasured-until-the-same-suite-is-run-through-that-model`.

Generate a leakage-minimized comparison pack with:

```bash
npm run benchmark:archie:prompt-pack
```

A named model may be compared only after its returned `archie-candidate-results/v1` file is scored with the exact same executable contract.

## Default proof surface

`npm run test:archie` executes every `scripts/tests/maker-archie-*.test.mjs` suite. The default gate therefore includes corpus, sparse brain, budget, planner, cognition, derivation, compute, pack, sync, evaluation, benchmark, phone and native integration tests that exist on the checked-out tree.

`npm run test:maker` runs Maker core plus the same complete Archie test surface.

## Claim boundary

The demonstrated claim is:

> Archie can retain bounded digital procedures as abstract operator/adaptor relations, compose known transformations, bind supplied adapters to unseen domains, emit proof-carrying tool plans, reject learned authority violations and escalate unknown work without requiring a larger model.

The repository does **not** claim unrestricted conversation, open-world knowledge, neural language generation, autonomous production authority or general intelligence.
