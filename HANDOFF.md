# Engineering handoff

## Final repository state

The independent-program product direction is merged to `main` through PR #511.

- Merge SHA: `4b2386606a8e43e7914fd0e837cec5f496cc9e49`
- Exact feature head merged: `33338a96f4cb6035e09e92de598a72caae192ec7`
- GitHub authority: #506
- Linear authority: POK-101
- Product contract: `product/xp-program-surfaces.json`

The repository product direction is **independent, opaque applications**, not a shared AI dashboard or cognition pipeline.

## What exists

- `/` and `/desktop/` — Archie Program Manager. It launches separate programs and performs no hidden model work.
- `/archie/` — Archie Knowledge Utility with Explorer, request editor, properties inspector, portable objective packets, local recovery, and explicit runtime boundaries.
- `/maker/` — Maker project workbench with repository identity, protected reality, proof, authority selection, public execution state, and authenticated runtime-receipt inspection.
- `/founder/` — Founder human-invention room, preserved as an independent application.
- `/foundry/` — Foundry Research Control with campaign configuration, contradictory candidate specimens, evidence console, and human promotion gates.
- `/world-expo/` — Expo, preserved as an independent public experiment gallery.

Each program has its own route, interface grammar, control model, phone layout, and claim boundary.

## Hard product rules

Do not reintroduce:

- glass, frosted, translucent, or transparent primary surfaces;
- bento cards, feature tiles, or large decorative image navigation;
- an intention → planning → reasoning icon pipeline;
- one dashboard that treats Archie, Maker, Founder, Foundry, and Expo as stages;
- a generic AI SaaS shell;
- stacked rounded cards as the mobile fallback;
- streaks, levels, followers, leaderboards, fake progress, routine confetti, or engagement ranking.

Use title bars, menus, buttons, lists, files, fields, tabs, dialogs, inspectors, logs, status bars, and opaque application surfaces.

## Evidence and contracts

`scripts/tests/xp-program-surfaces.test.mjs` rejects shared visual signatures, glass/translucency, pipeline vocabulary, remote UI dependencies, missing reduced-motion and forced-color support, and missing phone layouts.

`scripts/deployment-receipt.cjs` identifies the public root as `desktop-program-manager`, verifies the exact deployed commit, and independently verifies Founder at `/founder/` and Archie at `/archie/`.

`.github/workflows/pages.yml` builds, tests, assembles, and deploys the independent programs.

Primary verification commands:

```bash
npm ci --ignore-scripts --include=dev
node --test scripts/tests/deployment-receipt.test.mjs scripts/tests/founder-superiority.test.mjs
npm run test:xp-surfaces
npm run test:portfolio
npm run test:founder
npm run test:foundry:human
npm run test:frontier-expo
node scripts/tests/maker-console.test.mjs
node --test scripts/tests/maker-ios-install.test.mjs scripts/tests/archie-phone-product.test.mjs
```

## Truth boundary

The public applications are runnable interaction surfaces. Their existence does not prove model execution, training, repository mutation, deployment, frontier capability, or general intelligence.

Archie remains an evidence-gated learned planning/model system with persistent Core and Generation One infrastructure. External effects remain Maker-authorized. Capability promotion remains evidence-bound.

## Remaining operational check

The code merge is complete. The next operator only needs to inspect the `main`-branch Pages run for merge SHA `4b2386606a8e43e7914fd0e837cec5f496cc9e49`, confirm the Program Manager root and independent `/founder/` and `/archie/` reachability receipts, then close #506 and POK-101 if live verification is green.

Do not rewrite or reopen the product architecture merely because deployment propagation or one CI witness needs repair. Fix the exact operational failure and preserve the merged product contract.

## Successor authority

The next engineer may refine implementation, sequencing, storage, schemas, dependencies, algorithms, tests, CI, and visual details. They may replace a subsystem when evidence supports a stronger architecture.

Stop only for missing credentials, irreversible external spending, legal acceptance, or a genuinely unresolved product decision. Do not stop merely because a normal code, test, CI, issue, PR, merge, or deployment problem requires another iteration.
