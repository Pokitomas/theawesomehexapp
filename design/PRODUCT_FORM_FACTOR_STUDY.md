# Product form factor as operational architecture

Archie treats form factor as part of the executable product profile rather than decoration. An interface changes what people notice, understand, authorize, recover, trust, and complete. The product family therefore shares accessibility and evidence rules while giving each program a form that matches its actual work.

## Research method

This is a bounded public-corpus study, not a popularity scrape or a claim that attractive styling automatically causes commercial success.

The corpus includes first-party platform guidance, public-sector design systems, accessibility standards, mature product design systems, and disclosed usability research. Screenshot galleries, awards, trend posts, and unsourced opinion are excluded because they cannot establish task performance or authority comprehension.

Three evidence classes are retained:

1. **Normative standards** define minimum operability and accessibility requirements.
2. **Practice-derived systems** encode patterns refined across large products and platforms.
3. **Usability research** can support narrower behavioral relationships such as field complexity and completion.

Guidance becomes a testable product hypothesis. Adoption, retention, revenue, delight, and task success still require observed product telemetry or controlled user evaluation.

## Corpus

The machine-readable registry lives in `design/product-form-factor-metadata.json` and currently binds fifteen sources from eight publishers.

- Apple Human Interface Guidelines: purpose, agency, flexibility, simplicity, craft, delight, adaptable layout, and accessible multi-input experiences. Sources: https://developer.apple.com/design/human-interface-guidelines/design-principles , https://developer.apple.com/design/human-interface-guidelines/layout , and https://developer.apple.com/design/human-interface-guidelines/accessibility/
- GOV.UK Design System: small-screen-first composition, bounded reading width, responsive spacing, relative typography, and consistent rhythm. Sources: https://design-system.service.gov.uk/styles/layout/ , https://design-system.service.gov.uk/styles/spacing/ , and https://design-system.service.gov.uk/styles/type-scale/
- W3C WCAG 2.2: keyboard operability, visible focus, target sizing, reflow, and state communication that does not depend on color alone. Sources: https://www.w3.org/TR/WCAG22/ and https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
- GitHub Primer: natural reading order, focused responsive layouts, semantic hierarchy, descriptive controls, visible labels, nearby errors, and document metadata. Sources: https://primer.style/product/getting-started/foundations/layout/ and https://primer.style/accessibility/tools-and-resources/checklists/designer-checklist/
- Microsoft Fluent 2: platform-natural behavior, reliability, proximity, hierarchy through spacing, density control, contrast, reflow, and plain language. Sources: https://fluent2.microsoft.design/design-principles , https://fluent2.microsoft.design/layout , and https://fluent2.microsoft.design/accessibility
- IBM Carbon: equal-quality experiences, adaptation, semantic structure, and predictable keyboard order. Source: https://carbondesignsystem.com/guidelines/accessibility/overview/
- Baymard Institute: observed checkout friction, excessive field complexity, visible progress, and completion. Source: https://baymard.com/blog/current-state-of-checkout-ux

## Relationship model

The defensible relationship is conditional rather than aesthetic determinism:

```text
software ambition
→ exact user outcome
→ required authority and evidence
→ dominant task and frequency
→ task-matched form factor
→ hierarchy, density, disclosure, and interaction policy
→ completion, comprehension, recovery, and error behavior
→ measured product success or a falsified design hypothesis
```

A form factor is successful when it minimizes the distance between intent and verified completion without concealing uncertainty, capability, or authority.

Visual polish can improve perceived usability and willingness to engage, but perception is not proof of correct behavior. A polished false-completion state is worse than an austere truthful one. The design system therefore treats aesthetics as an amplifier of legibility and confidence, never as a substitute for execution evidence.

## Testable hypotheses

### Task–form fit

A surface whose hierarchy and density match its dominant task should reduce orientation and mode-switch cost.

Measure: time to primary action, completion rate, wrong-surface navigation, and abandonment before the first meaningful action.

### Authority legibility

Visible capability, permission, and receipt boundaries should reduce false-completion beliefs without hiding useful actions.

Measure: authority comprehension, false-completion rate, proof inspection, and attempts to invoke unavailable authority.

### Progressive evidence

Keeping primary work prominent while progressively disclosing machine evidence should improve completion without sacrificing inspectability.

Measure: task completion, time to primary action, evidence-retrieval success, and receipt comprehension.

### Responsive operability

Complete reflow, readable controls, visible focus, and multiple input paths should preserve task success across phone, desktop, zoom, keyboard, and touch contexts.

Measure: horizontal overflow, keyboard completion, touch error, focus-order failure, and zoom-reflow failure.

### Product recognition

Distinct visual languages should help people recognize the program role and expected consequence before acting.

Measure: five-second role identification and cross-product action error.

## Product personalities

### Archie — intelligence cockpit

- Emotional target: calm expectancy, not terminal anxiety.
- Dominant action: articulate an outcome and preserve context.
- Form: soft dark spatial canvas, large editorial objective field, luminous but truthful runtime signals, compact authority controls, and progressive receipt disclosure.
- Metadata: objective digest, continuity mode, runtime observation, authority grants, and proof requirements.
- Success signals: completed objective packets, correct authority comprehension, and low false belief that the phone executed work.
- Failure to avoid: a generic chat box or a polished shell that implies an unadmitted model performed execution.

### Maker — engineering control room

- Emotional target: precision and operational confidence.
- Dominant action: bind work to repository, base, authority, and proof.
- Form: high-density monospace control surface, rigid consequence boundaries, visible state, and a clean single-column mobile collapse.
- Metadata: exact base, backend, lease, tools, status, workflow state, and receipts.
- Success signals: completed dispatches, low authority-error rate, and fast receipt retrieval.
- Failure to avoid: playful styling that obscures consequences or raw terminal density that makes ordinary work illegible.

### Founder — decision studio

- Emotional target: taste, comparison, and consequence.
- Dominant action: compare directions and commit to a product interpretation.
- Form: editorial gallery with materially different concepts, oversized typography, deliberate contrast, and visible decision stakes.
- Metadata: direction, reaction, decision summary, and rejection rationale.
- Success signals: concept differentiation, completed decisions, and later decision recall.
- Failure to avoid: visual sameness between alternatives or a dashboard that reduces creative judgment to status cards.

### Sideways — lived archive

- Emotional target: intimate ownership and discovery.
- Dominant action: save, revisit, connect, and browse personal or public material.
- Form: content-first reading surface with quiet controls, recognizable document typography, and strong separation between private archive and public discovery.
- Metadata: provenance, rank, privacy, backup state, identity, and moderation authority.
- Success signals: save/restore survival, provenance comprehension, and sustained content readability.
- Failure to avoid: importing Maker or Archie operational density into a reading product.

## Shared system

All products share:

- a 4/8/12/16/24/32/48/64 spacing grammar;
- a 24px WCAG 2.2 AA target floor and a preferred 44px touch target for consequential controls;
- 16px touch text for editable fields to preserve mobile readability;
- visible focus treatment and logical keyboard order;
- reduced-motion behavior where animation or smooth scrolling exists;
- explicit state labels that never depend on color alone;
- local recovery and visible destructive-action boundaries;
- progressive disclosure for receipts and machine metadata;
- product-specific color, radius, density, typography, and motion rather than one reskinned template.

## Executable style contracts

- Archie: `archie/archie.css` with byte-identical deployed parity at `dist/archie/archie.css`.
- Maker: `maker/maker.css`.
- Founder: `founder/founder.css`.
- Sideways: `studio/manual/product/sideways-human.css`, applied last over the generated archive layers.

The regression gate verifies that all four contracts exist, expose distinct visual grammars, and remain bound to the product roles in the metadata registry.

## Admission tests

A surface is rejected when:

1. the primary outcome cannot be identified quickly;
2. the primary action is visually equal to secondary actions;
3. authority is implied rather than stated;
4. phone or zoom use requires horizontal page scrolling;
5. consequential touch controls miss the preferred target without a justified exception;
6. editable touch text becomes difficult to read;
7. keyboard focus is absent, obscured, or illogical;
8. state is communicated by color alone;
9. generated machine data is mistaken for completed work;
10. destructive actions lack separation or recovery;
11. the visual personality does not match the work performed;
12. the product cannot explain its current capability boundary.

## Evaluation boundary

Repository tests can prove source parity, the presence of style contracts, responsive rules, semantic metadata, and explicit authority language. They cannot prove delight, comprehension, completion, retention, or commercial success. Those claims require instrumented journeys or controlled human evaluation against the success proxies recorded in the metadata registry.
