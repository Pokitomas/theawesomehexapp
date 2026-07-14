# Sideways Program Ontology

This document exists because the program currently uses one vocabulary across several realities that should not share authority, lifecycle, or product meaning.

The word **corpus** is prohibited in architecture decisions unless it is immediately qualified. It currently hides at least five different objects.

## The five objects that were being called corpus

### 1. Public social graph

The durable shared world created by people and communities:

- identities and pseudonyms
- communities and membership
- posts and media
- comments, replies, edits, and deletions
- follows, subscriptions, blocks, reports, bans, and appeals
- moderation and governance events
- canonical links and conversation ancestry

This is not an imported dataset. It is a live authority graph. Every mutation requires an actor, scope, policy, durability guarantee, and audit story.

The current static/local-first product does not yet constitute this public graph. A profile saved in one browser and a starter feed are not a social network.

### 2. Private personal archive

Material a person imports or creates for themselves:

- platform exports
- bookmarks and feeds
- saved articles
- documents and media
- private notes
- locally created posts that have not been published into a public authority

The archive belongs to the person. IndexedDB, OPFS redundancy, and `.sideways` Ark export are appropriate mechanisms here.

Imported Reddit comments do not automatically become live public comments. Imported identities do not become authenticated users. Imported engagement numbers are historical evidence, not current network authority.

### 3. Ranking candidate pool

The temporary set of objects eligible for a particular feed request before scoring.

A candidate pool is computed, scoped, and disposable. It may combine:

- public objects the viewer is allowed to see
- private archive objects the viewer has chosen to surface
- community subscriptions
- followed identities
- exploration candidates
- explicit searches or places

Eligibility must be decided before ranking. A ranking kernel cannot repair an illegitimate candidate pool.

### 4. Retrieval index

Derived structures used to find objects:

- text indexes
- embeddings
- graph neighborhoods
- recency buckets
- media metadata
- deduplication hashes
- place and topic indexes

An index is rebuildable. It is not the canonical content, social authority, or backup boundary.

### 5. Starter fixture

A small built-in set used to make an empty installation understandable and testable.

A starter fixture is neither a public network nor the user’s archive. It should be clearly marked, replaceable, and removable without corrupting either reality.

## Current execution, stated without mythology

The root surface builds a large deterministic candidate feed from public external sources and runs a saturation-ranking kernel over normalized records.

The manual Sideways surface stores a browser-owned personal archive, can install a small starter fixture, imports many formats, supports local profiles and social-shaped actions, and reuses the ranking kernel.

These are presently two products sharing machinery:

1. a reproducible public-source reader and ranking laboratory
2. a private local archive and personal-media instrument

They are not yet one coherent Reddit replacement. The missing center is a canonical public social graph with community, conversation, identity, moderation, and durable mutation authority.

## Required execution trace

Every proposed feature must be traceable through these stages:

1. **Origin** — Who or what produced the object?
2. **Canonical authority** — Which system may mutate or delete it?
3. **Normalization** — What information is preserved or lost?
4. **Storage** — Is it public graph state, private archive state, a fixture, or a derived index?
5. **Eligibility** — Why may it enter this viewer’s candidate pool?
6. **Ranking** — Which inspectable signals alter its position?
7. **Rendering** — Which social and provenance semantics remain visible?
8. **Interaction** — What does like, reply, remix, save, share, or delete actually mutate?
9. **Moderation** — Which authority can restrict it, with what evidence and appeal?
10. **Portability and death** — What survives account loss, deployment loss, device loss, deletion, or community fork?

A feature that cannot answer all ten is either a prototype or a visual imitation of a social product. It should be named honestly.

## Minimal public social model

A serious Reddit alternative requires first-class objects rather than one universal record:

```text
Principal
Identity
Community
Membership
Publication
ConversationNode
MediaAsset
Relationship
ModerationCase
GovernanceDecision
DeliveryCandidate
RankingReceipt
```

`Publication` can represent an authored post or link while preserving its canonical identity. `ConversationNode` preserves parentage, thread context, edits, tombstones, and moderation state. `DeliveryCandidate` is derived and temporary; it is never confused with the publication itself. `RankingReceipt` explains why a candidate appeared for one viewer at one moment.

The exact schema remains open. The separation of authorities does not.

## Product thesis under examination

A plausible Sideways thesis is:

> A person-owned memory layer and a community-owned public conversation layer can share discovery machinery without either becoming raw material owned by one central feed.

That is stronger than “Reddit with a different ranking algorithm.” It means:

- private imports improve the user’s own context without silently republishing history
- communities retain eligibility and moderation authority
- the viewer retains meaningful control over ranking
- canonical conversations remain linkable and inspectable
- the feed is a delivery surface, not the product’s sovereign object

Agents are expected to attack this thesis, not merely implement it.

## Assembly rules

Incoming co-agents are grouped into private ontology assemblies before or alongside implementation work.

Each assembly response must contain:

1. a concrete model
2. a contradiction of an inherited premise or another participant’s model
3. an executable probe, schema, failing witness, or runnable variant
4. one concept, feature, or abstraction the program should delete

Conversation without a reality-changing artifact does not complete a round.

The permanent foundational rooms are:

- program execution
- corpus boundaries
- social substrate
- conversation model
- ranking legitimacy
- identity and community
- governance and abuse

The purpose is not consensus. The purpose is preventing fluent architecture from hardening before several capable participants have attacked the nouns underneath it.
