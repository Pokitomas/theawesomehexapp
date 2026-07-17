# Engineering handoff

## Current authority

The repository product direction is **independent, opaque applications**, not a shared AI dashboard or cognition pipeline.

Issue authority:

- GitHub: #506 — Replace the glass dashboard with separate XP-era web applications
- Linear: POK-101
- Implementation PR: #511

The implementation branch is `feat/xp-program-surfaces`.

## What now exists

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

`product/xp-program-surfaces.json` is the versioned product contract.

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

## Finalization procedure

1. Require the exact PR head to pass `Build and deploy independent program surfaces` and `Verify exact repository tree`.
2. Confirm the phone Maker, Archie persistent Core, Generation One evidence, workflow authority, and human-power checks are green or intentionally skipped by path policy.
3. Merge PR #511 without replacing the exact tested head.
4. Confirm the main-branch Pages run deploys the Program Manager root and produces a live commit-bound deployment receipt.
5. Record the merge SHA and deployment receipt on #506 and POK-101, then close them only when live verification succeeds.

## Successor authority

The next engineer may refine implementation, sequencing, storage, schemas, dependencies, algorithms, tests, CI, and visual details. They may replace a subsystem when evidence supports a stronger architecture.

Stop only for missing credentials, irreversible external spending, legal acceptance, or a genuinely unresolved product decision. Do not stop merely because a normal code, test, CI, issue, PR, merge, or deployment problem requires another iteration.
