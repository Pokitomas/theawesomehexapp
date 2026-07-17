# Indie form factors as product engines

The product family should not look like security software merely because its boundaries are truthful. Safety, authority, and receipts remain behavioral contracts. The visible form should instead make each program feel worth entering, making, revisiting, and sharing.

This study therefore centers the independent web: personal homepages, Neocities, IndieWeb practice, expressive online communities, and research on identity, mastery, retention, and community survival.

## What counts as success

Indie success is not one leaderboard number. Research on online communities separates growth, retention, long-term survival, and activity because they are related but not interchangeable. A product may be small and deeply alive, large and disposable, or visually famous but rarely revisited.

For this family, success means some combination of:

- people can recognize what kind of place they entered;
- making the first meaningful thing is easy;
- the result feels personally authored rather than template-owned;
- updates create reasons to return;
- discovery leads sideways into other people, artifacts, and interests;
- content remains portable and user-owned;
- the product survives without requiring infinite growth;
- the interface is memorable without becoming unusable.

## Corpus

### Neocities

Neocities explicitly frames itself as a canvas for independent, creative sites rather than a generic social profile. It emphasizes personality, open source, a permanent free option, no advertising, no data sale, easy downloads, custom domains, and anti-lock-in. Its browse surface exposes tags, site names, views, and radically different personal forms instead of forcing one feed template.

Sources:

- https://neocities.org/about
- https://neocities.org/browse

Derived patterns:

- blank-canvas authorship;
- site identity before platform identity;
- visible diversity rather than one optimized skin;
- tags and neighborhoods as discovery infrastructure;
- ownership and portability as part of the product promise;
- low-cost entry with room for endless elaboration.

### IndieWeb

The IndieWeb principles prioritize owning identity and content, publishing on one’s own site, showing human-readable information first, designing experience before protocols, using the thing personally, and keeping the web fun.

Sources:

- https://indieweb.org/
- https://indieweb.org/principles

Derived patterns:

- personal utility before platform scale;
- artifact-first interaction rather than dashboard-first interaction;
- visible authorship and provenance;
- plurality of approaches instead of product monoculture;
- creation loops that produce something the user can keep.

### Personal-homepage research

Research on personal homepages describes them as media for identity construction and self-presentation. Studies of young people connect homepage creation with mastery, identity exploration, and socialization. Work comparing personal and institution-managed pages shows how standardized corporate forms can suppress multi-dimensional identity.

Sources:

- https://academic.oup.com/jcmc/article/7/3/JCMC737/4584273
- https://pubmed.ncbi.nlm.nih.gov/18331139/
- https://research-portal.uea.ac.uk/en/publications/individuality-or-conformity-identity-in-personal-and-university-a/

Derived patterns:

- customization is functional identity work, not decorative noise;
- visible progress creates mastery;
- collections, shrines, logs, and personal taxonomies are legitimate primary forms;
- over-standardization can erase the reason a person cares about the product.

### Community success research

Research across many online communities finds that distinctive and dynamic identities are associated with stronger retention, while highly distinctive communities can also create newcomer barriers. Other work shows that community success is multi-dimensional and that different outcomes have different predictors.

Sources:

- https://arxiv.org/abs/1705.09665
- https://arxiv.org/abs/1903.07724

Derived patterns:

- recognizable identity helps retention;
- visible recent activity makes a place feel alive;
- strong personality needs obvious entry points for newcomers;
- success must be measured separately as return, activity, survival, creation, and connection.

## Causal model

```text
human motive
→ first expressive act
→ visible authored artifact
→ recognizable place identity
→ update and discovery loops
→ return, mastery, attachment, and community connection
→ sustainable indie success
```

Form factor matters because it changes whether a person feels like an operator filling out a system or an author making a place.

The product rejects the following default chain:

```text
serious software
→ dark dashboard
→ warning-colored status chips
→ security-console density
→ generic enterprise legitimacy
```

Truthfulness does not require that aesthetic. Boundaries should be plain, local, and proportionate; they should not become the emotional center of every screen.

## Shared indie laws

Every product should expose:

1. **A nameable place.** A visitor can describe the form in ordinary language: atelier, workshop, zine wall, homepage.
2. **A first expressive act.** The opening screen invites making, choosing, collecting, or writing—not configuring infrastructure.
3. **Visible authorship.** The result visibly belongs to a person or project.
4. **A progress trace.** Updates, drafts, logs, collections, or receipts show that the place changes over time.
5. **Sideways discovery.** Tags, related artifacts, references, neighbors, or paths create curiosity beyond the primary task.
6. **Portable output.** The meaningful artifact can be copied, exported, downloaded, or moved.
7. **Specific personality.** Color, typography, rhythm, labels, and layout follow the product’s culture rather than a shared dashboard kit.
8. **Newcomer handles.** Personality does not erase obvious navigation, readable controls, reflow, keyboard access, or clear primary actions.

## Product forms

### Archie — personal atelier

Archie is the place where an unfinished desire becomes a shaped brief.

- Form: notebook, scrapbook, idea board, and takeaway packet.
- First expressive act: write what should exist.
- Return loop: reopen a local draft, refine it, carry it into another workshop.
- Personality: cream paper, colored tape, stamps, uneven cards, editorial text.
- Avoid: black glass, glowing runtime telemetry, command-center prestige, generic chatbot framing.

### Maker — software workshop

Maker is where a build card becomes visible work.

- Form: garage bench, graph paper, build cards, labels, parts bins, and a public build log.
- First expressive act: state the end result and starting material.
- Return loop: inspect open work, recent runs, receipts, and the next build card.
- Personality: coral shop sign, graph grid, paper cards, bright status labels, physical depth.
- Avoid: SOC dashboard, terminal cosplay, military authorization language as visual identity.

### Founder — indie zine decision wall

Founder is where competing interpretations are placed beside each other and judged.

- Form: zine spread, moodboard, pinned concepts, marginal notes, and a decision page.
- First expressive act: react to materially different directions.
- Return loop: revisit rejected directions and the recorded rationale.
- Personality: tape, collage, rotated sheets, oversized serif headlines, clashing but deliberate color.
- Avoid: interchangeable product cards, sanitized consultant deck, generic analytics dashboard.

### Sideways — neighborhood homepage

Sideways is a personal corner of the web that opens into other corners.

- Form: homepage, collection cabinet, update log, reading stack, and neighborhood path.
- First expressive act: save, post, import, or arrange something personally meaningful.
- Return loop: new updates, saved material, collections, places, and neighboring sources.
- Personality: warm paper, colored tabs, visitor-page energy, explicit “you are here” navigation, authored cards.
- Avoid: institutional wiki, enterprise content system, invisible ownership, infinite-feed sameness.

## Executable style contracts

- Archie: `archie/archie.css`
- Maker: `maker/maker.css`
- Founder: `founder/founder.css`
- Sideways base: `studio/manual/product/sideways-human.css`
- Sideways final indie layer: `studio/manual/product/sideways-indie.css`

The Sideways installer must copy and load the indie layer after the ordinary human layer.

## Evaluation

The first evaluation is not “does this look professional?” It is:

- Can a new person identify the place in five seconds?
- Can they make or choose something meaningful without setup detours?
- Does the artifact feel personally authored?
- Can they find evidence of change over time?
- Is there an obvious path to another artifact, source, collection, or neighbor?
- Can they export or carry the result elsewhere?
- Do they remember which product they used a day later?
- Do they return because the place feels alive, not because a notification coerced them?

Repository tests can prove style contracts, responsive rules, installation order, and product distinction. Human studies or production telemetry are still required to prove mastery, attachment, retention, discovery, and long-term survival.
