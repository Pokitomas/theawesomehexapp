# Product form factor as operational architecture

Archie treats form factor as part of the executable product profile rather than decoration. The interface determines what users understand, authorize, recover, trust, and complete. A sophisticated product therefore matches visible form to actual authority and capability.

## Evidence pulled into the product model

- Apple Human Interface Guidelines: purpose, familiarity, simplicity, craft, delight, responsibility, hierarchy, adaptability, progressive disclosure, and explicit recovery from mistakes. Sources: https://developer.apple.com/design/human-interface-guidelines/design-principles and https://developer.apple.com/design/human-interface-guidelines/layout
- Apple accessibility guidance: interfaces must be intuitive, perceivable, and adaptable, not dependent on one mode of perception or interaction. Source: https://developer.apple.com/design/human-interface-guidelines/accessibility/
- GOV.UK Design System: mobile-first single-column composition, bounded reading width, responsive spacing scales, relative typography, and consistent vertical rhythm. Sources: https://design-system.service.gov.uk/styles/layout/ , https://design-system.service.gov.uk/styles/spacing/ , and https://design-system.service.gov.uk/styles/type-scale/
- Baymard usability research: friction and excessive field complexity materially cause abandonment; strong interfaces reduce visible work, clarify progress, and avoid hidden save/apply states. Sources: https://baymard.com/blog/current-state-of-checkout-ux and https://baymard.com/blog/checkout-usability-apply-buttons

## Archie derivation

The relationship is causal:

```text
software ambition
→ exact user outcome
→ required authority and evidence
→ dominant interaction frequency
→ suitable form factor
→ hierarchy and disclosure policy
→ visual language
→ completion and recovery behavior
→ measurable product success
```

A form factor is successful when it minimizes the distance between intent and verified completion without concealing uncertainty or authority.

## Product personalities

### Archie — intelligence cockpit

- Emotional target: calm expectancy, not terminal anxiety.
- Dominant action: articulate an outcome and preserve context.
- Form: soft dark spatial canvas, large editorial objective field, luminous admission signals, compact authority controls.
- Metadata: objective digest, continuity mode, runtime observation, authority grants, proof requirements.
- Failure to avoid: looking like a generic chat box or pretending the phone performed execution.

### Maker — engineering control room

- Emotional target: precision and operational confidence.
- Dominant action: bind work to repository, base, authority, and proof.
- Form: high-density desktop control surface that collapses cleanly into a single mobile column.
- Metadata: exact base, backend, lease, tools, status, workflow state, receipts.
- Failure to avoid: playful styling that obscures consequences or a raw terminal aesthetic that makes ordinary work illegible.

### Founder — decision studio

- Emotional target: taste, comparison, consequence.
- Dominant action: compare directions and commit to a product interpretation.
- Form: editorial gallery with materially different concepts, oversized typography, deliberate contrast, and visible decision stakes.
- Metadata: direction, reaction, decision summary, rejection rationale.
- Failure to avoid: visual sameness between alternatives or a dashboard that reduces creative judgment to status cards.

### Sideways — lived archive

- Emotional target: intimate ownership and discovery.
- Dominant action: save, revisit, connect, and browse personal/public material.
- Form: content-first reading surface with quiet controls and strong separation between private archive and public discovery.
- Metadata: provenance, rank, privacy, backup state, identity, moderation authority.
- Failure to avoid: importing Maker or Archie operational density into a reading product.

## Shared system

All products share:

- a 4/8/12/16/24/32/48/64 spacing grammar;
- readable system typography with editorial display sizes and monospaced evidence metadata;
- minimum 44px touch targets;
- strong focus rings and reduced-motion support;
- explicit state labels that never depend on color alone;
- local recovery and visible destructive-action boundaries;
- progressive disclosure for receipts and machine metadata;
- product-specific color, radius, density, and motion rather than one reskinned template.

## Admission tests

A surface is rejected when:

1. the primary outcome cannot be identified in five seconds;
2. the primary action is visually equal to secondary actions;
3. authority is implied rather than stated;
4. mobile requires horizontal scrolling;
5. text controls fall below 16px on touch devices;
6. state is communicated by color alone;
7. generated machine data is mistaken for completed work;
8. destructive actions lack separation or recovery;
9. the visual personality does not match the work performed;
10. the product cannot explain its current capability boundary.
