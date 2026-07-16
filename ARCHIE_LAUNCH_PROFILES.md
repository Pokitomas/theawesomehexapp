# Archie launch profiles

Archie has no architectural chat, voice, screen, daemon, phone, CLI, IDE, or always-on identity.

The maximal product claim is selected from complete evidence-bound profiles. Each profile binds one exact model release, one exact environment, its actual modalities and invocation modes, measured intelligence and embodiment outcomes, authority grants, platform constraints, latency, privacy behavior, and aggregate resources.

## Canonical v2 frontier

```text
npm run archie:launch:frontier -- --manifest frontier-manifest.json
```

The v2 manifest contains:

- one exact signed model/checkpoint/runtime/code release;
- exact hardware and operating-system fingerprints for every environment;
- complete candidate profiles for those environments;
- intelligence, embodiment, authority, latency, privacy, and resource measurements on the same profile;
- evidence digests, permissions, resource budgets, activation conditions, and platform constraints;
- a search receipt that binds the enumerated profile set and records excluded candidates.

The resolver first rejects experimental, unevidenced, unauthorized, over-budget, or below-gate profiles. It then compares every feasible profile on every declared objective.

A profile dominates another only when it is no worse on every objective and strictly better on at least one. The surviving Pareto frontier is the strongest truthful product set for that environment.

An incomparable profile is not discarded merely because another profile has a different strength. A low-latency voice profile and a higher-precision visual profile may both ship as an adaptive frontier. No primary profile is invented unless the environment supplies an explicit selection policy. A requested default that is dominated or infeasible rejects the environment instead of silently weakening the maximal claim.

## Per-environment product form

The frontier is computed separately for every exact environment. A desktop may admit consented event-driven continuity while a mobile operating system admits only foreground or scheduled interaction. A local workstation may admit a private high-memory model while a phone admits a hybrid profile. These are truthful environment profiles, not different definitions of Archie.

Voice, background execution, notifications, screens, cameras, headless APIs, and persistent presence appear only when a measured profile includes and proves them. Their absence does not automatically reject an otherwise nondominated profile unless the profile fails the human outcome metrics in the target.

## Compatibility backend

The existing v1 commands remain available:

```text
npm run archie:launch:derive
npm run archie:launch:evaluate -- --candidate candidate.json
npm run archie:launch:resolve -- --manifest launch-capability-manifest.json
```

They preserve the earlier fixed-faculty target, candidate admission, machine permissions, dependency closure, aggregate resources, and named fallbacks. They may supply evidence or act as a compatibility backend, but their required-faculty mapping and inclusion-maximal capability sets are not the canonical maximal-product decision.

A maximal Archie launch claim requires `archie-launch-frontier-decision/v2` with:

- complete search;
- joint intelligence-and-embodiment gates;
- exact environment separation;
- a nondominated frontier;
- rejection of dominated defaults;
- explicit excluded and failed profiles;
- digest-bound deterministic output.

## Current boundary

These contracts define selection law. They do not establish that the current Archie checkpoint is generally competent, that production speech or ambient continuity exists, or that any particular platform grants the needed permissions. Consumer promotion still requires independent model evaluation, clean-machine reproduction, real-device profile receipts, and a passing v2 frontier decision.
