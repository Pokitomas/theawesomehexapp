# Sideways Program Ontology

This document exists because the program once used one vocabulary across realities that must not share authority, lifecycle, storage, or product meaning.

The word **corpus** is prohibited in architecture decisions unless it is immediately qualified as the **private personal archive** or a deliberately bounded test fixture. It must never name the public social graph, a feed response, a ranking candidate pool, or the product’s total state.

## The five distinct objects

### 1. Public social graph

The durable shared world created by authenticated people and communities:

- identities and pseudonyms
- communities and membership
- publications and media
- comments, replies, edits, and deletions
- follows, reactions, blocks, reports, bans, and appeals
- moderation and governance events
- canonical links and conversation ancestry

This is not an imported dataset. It is live authority. Every mutation requires an actor, scope, denial boundary, durability guarantee, replay rule, and audit story.

The repository now implements this authority rather than merely imitating its interface. Server-backed accounts, profiles, publications, follows, reactions, author deletion, community membership, moderation, immutable appeals, viewer-local controls, events, and idempotent mutation receipts are executable. PostgreSQL is the complete relational authority; the Blob fallback intentionally exposes a smaller public operation set. Consumer UI coverage remains narrower than the backend authority.

### 2. Private personal archive

Material a person imports or creates for themselves:

- platform exports
- bookmarks and feeds
- saved articles
- documents and media
- private notes
- locally created posts that have not been published into public authority

The archive belongs to the person. IndexedDB, OPFS redundancy, and `.sideways` Ark export are appropriate mechanisms here. The existing `corpus-db.js` name refers only to this private archive compatibility boundary.

Imported Reddit comments do not automatically become live public comments. Imported identities do not become authenticated users. Imported engagement numbers are historical evidence, not current network authority.

### 3. Ranking candidate pool

The temporary set of objects eligible for one feed request before scoring.

A candidate pool is computed, scoped, and disposable. It may combine:

- public objects the viewer is allowed to see
- private archive objects the viewer has chosen to surface
- community subscriptions
- followed identities
- exploration candidates
- explicit searches or places

Eligibility must be decided before ranking. A ranking kernel cannot repair an illegitimate candidate pool.

Public cache retention, named view membership, and active candidate materialization are separate. `discover(A,B) → following(B)` may remove A from the active candidate pool, but it does not delete A from public authority, the retained public cache, or the private archive.

### 4. Retrieval index

Derived structures used to find objects:

- text indexes
- embeddings
- graph neighborhoods
- recency buckets
- media metadata
- deduplication hashes
- place and topic indexes

An index is rebuildable. It is not canonical content, social authority, or a backup boundary.

### 5. Starter fixture

A small built-in set used to make an empty installation understandable and testable.

A starter fixture is neither a public network nor the user’s archive. It is explicitly marked, replaceable, and removable without corrupting either reality.

## Current execution, stated without mythology

Sideways now has three real product layers sharing ranking machinery:

1. **Public-source reader and ranking laboratory** — the root surface builds a large deterministic candidate feed from external sources. Those normalized records are delivery inputs, not the canonical Sideways social graph.
2. **Private personal archive** — the manual surface imports and stores user-owned material, supports local creation and recovery, and can combine selected private records with eligible public projections.
3. **Canonical public social authority** — configured server deployments own authenticated shared mutations. Relational mode implements communities, conversation governance, moderation, appeals, viewer controls, deletion, events, and request-bound idempotency.

The missing center is no longer a schema or authority engine. The remaining product problem is convergence: expose the implemented public graph through coherent consumer journeys without collapsing it into the private archive or allowing the feed to become the sovereign object.

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

A feature that cannot answer all ten is either a prototype or a visual imitation. It must be named honestly.

## Implemented public social model

The public authority uses first-class objects rather than one universal record:

```text
Principal
PublicProfile
Session
Community
Membership
Publication
ConversationNode
Relationship
ModerationCase
ModerationAction
Appeal
ViewerLocalControl
SocialEvent
MutationReceipt
```

`Publication` preserves canonical authorship and identity. `ConversationNode` preserves parentage, thread context, edits, tombstones, and moderation state. Viewer-local controls alter one viewer’s eligibility without mutating canonical public state. Mutation receipts bind operation, actor, and keyed request identity. Delivery candidates and ranking receipts remain derived; they are not public authority objects.

The exact product presentation remains open. The separation of authorities does not.

## Product thesis under examination

> A person-owned memory layer and a community-owned public conversation layer can share discovery machinery without either becoming raw material owned by one central feed.

This is stronger than “Reddit with a different ranking algorithm.” It requires:

- private imports improve the user’s own context without silently republishing history
- communities retain eligibility and moderation authority
- the viewer retains meaningful local control over ranking and visibility
- canonical conversations remain linkable and inspectable
- the feed remains a delivery surface, not the product’s sovereign object
- cached public projections remain rebuildable and non-authoritative

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
- archive/public-graph boundaries
- social substrate
- conversation model
- ranking legitimacy
- identity and community
- governance and abuse

The purpose is not consensus. The purpose is preventing fluent architecture from hardening before several capable participants have attacked the nouns underneath it.
