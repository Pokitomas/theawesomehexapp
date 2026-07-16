# Archie launch profiles

Archie does not have one architectural interface.

A release is the combination of:

1. an independently admitted intelligence artifact;
2. one exact hardware and operating-system target;
3. measured and evidence-bound interaction, continuity, observation, execution, and privacy capabilities;
4. the strongest compatible profile that fits the machine, platform permissions, user authority, and aggregate resource envelope.

The resolver therefore answers a different question from “is Archie a chat app or a voice assistant?” It asks:

> Given this exact Archie release, this exact machine, these permissions, these receipts, and this human target, what is the strongest truthful product this installation can be?

## Three executable stages

```text
npm run archie:launch:derive
npm run archie:launch:evaluate -- --candidate candidate.json
npm run archie:launch:resolve -- --manifest launch-capability-manifest.json
```

### Derive

`archie:launch:derive` converts the human outcomes in `founder/archie-launch-target.json` into required faculties. The current maximal founder target derives speech, background continuity, subscribed-event awareness, visual inspection, connected-tool context, device continuity, and private local operation because those outcomes require them.

Changing the outcomes changes the required faculties. Voice, chat, a screen, and an always-running process are not retained as hidden defaults.

### Evaluate

`archie:launch:evaluate` jointly admits intelligence and target-level embodiment. A candidate must provide exact SHA-256 digests for its model artifact, intelligence report, authority report, clean reproduction receipt, faculties, and interfaces.

A strong model without the access modes demanded by the target fails. A polished shell without admitted cross-domain completion, repair, abstention, safety, and terminal evidence fails.

### Resolve

`archie:launch:resolve` consumes `archie-launch-capability-manifest/v1`. It binds:

- model artifact, checkpoint, runtime ABI, and code revision;
- the prior joint launch decision;
- exact hardware, operating system, and device fingerprints;
- user and platform permissions;
- network state;
- evidence, quality, and latency gates for every capability;
- dependencies, conflicts, minimum resources, and aggregate resource cost;
- explicit selection preferences;
- named fallback scenarios with exact changed constraints.

The resolver rejects unsupported capabilities, propagates failed dependencies, enumerates compatible dependency-closed profiles, removes profiles dominated by strict supersets, applies explicit preferences, and then admits the first profile whose combined memory, power, disk, accelerator, CPU, thermal, and other declared costs fit the exact machine envelope.

## Maximal does not mean fictional

The default receipt preserves:

- the selected exact-machine profile;
- every other maximal compatible profile;
- all disabled capabilities and exact reasons;
- missing required faculties;
- aggregate resource checks;
- proof that no hidden canonical interface selected the result.

A fallback is a separate scenario. Low-power, foreground-only, offline, revoked-permission, or other constrained profiles may be useful, but they do not overwrite the strongest default claim. A release cannot advertise ambient, voice, visual, proactive, cross-device, local, or other behavior merely because a prototype exists.

## Current claim boundary

These contracts define selection and admission law. They do not establish that the current Archie checkpoint has passed the maximal target, that every platform grants the needed permissions, or that production-quality speech, background execution, multimodal perception, battery behavior, and device continuity already exist.

Consumer launch still requires one exact release to pass independent intelligence evaluation, clean-machine reproduction, real-device embodiment tests, and the exact-machine resolver without missing critical faculties.
