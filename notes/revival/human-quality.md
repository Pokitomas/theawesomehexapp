# Human quality acceptance

- Parent: #223
- Lane: #231
- Branch: `revival/human-quality`
- Base: `main@ffcdda7bdcb6d2b7411b6c4965adf8837cb5a86a`
- State: static admission implemented; runtime quality matrix remains open

## Red witness repaired

Founder Room exposed an unlabeled note textarea and supplied no visible keyboard-focus style for buttons or the textarea. The branch now:

- associates `FOUNDER NOTE` with `#founder-note` using a real label;
- adds high-visibility `:focus-visible` outlines;
- preserves the existing 48px minimum action targets and responsive reflow.

## Executable baseline

`node scripts/human-quality-report.mjs` checks repository-visible quality markers for Founder Room and Maker:

- document language, viewport, and main landmarks;
- labels and named control groups;
- live status semantics;
- visible focus rules;
- minimum touch-target heights;
- narrow-screen reflow and overflow wrapping.

`npm run verify:quality` runs the contract and emits `sideways-human-quality/v1`. The suite is included in whole-repository verification, so removal of these static guarantees fails exact-tree admission.

## Honest unknowns

The report does not treat source inspection as proof of:

- VoiceOver, TalkBack, NVDA, or equivalent behavior;
- Chromium, Firefox, and WebKit compatibility;
- 200%/400% text zoom and reflow;
- computed contrast;
- reduced-motion behavior;
- focus order or focus traps;
- computed touch geometry;
- startup and realistic-scale performance;
- offline, latency, server failure, blocked storage, or quota pressure.

Those require dated browser/device journeys and performance fixtures under #231.

No feature, merge, or deployment authority.