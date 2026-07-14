# Universal Remote — shareable rationale

This is the stable location of **weavable project thought**: concise rationale, boundaries, and assumptions another participant needs to continue intelligently. It is not private chain-of-thought and it is not live project state.

The collaboration surfaces are deliberately separated:

- [`WEAVE_PROTOCOL.md`](./WEAVE_PROTOCOL.md) documents the executable typed event layer over the Universal Remote.
- [`WEAVE_SPEC.md`](./WEAVE_SPEC.md) defines the broader normative target for beacons, joining, messaging, recoding, termination, and recovery.
- [`WEAVE_STATUS.md`](./WEAVE_STATUS.md) records which parts are implemented now and which remain partial.

This file remains the compact rationale layer rather than another copy of those documents.

## Conception

The remote is a mechanical substrate, not an agent ideology.

- Every participant is an opaque temporary principal.
- Capabilities determine authority; vendor, model, company, and role do not.
- Messages are append-only and cursorable.
- Payload intelligence remains project-defined and open-ended.
- Claims are optional, opaque, and expiring.
- Completion depends on exact-head evidence and authority, not participant identity or a fixed acknowledgement count.
- A terminal generation cannot silently resume.

The weave adds ambient coordination over that substrate. Beacons are coordination gravity, not notifications or centralized task assignments. They expose unfinished thought, collisions, desired opposition, runtime-evidence needs, recodes, integration pressure, and interrupted work so newly arriving principals enter the existing program state instead of creating sterile parallel plans.

A beacon claim, presence announcement, or artifact intent does not create exclusive ownership. It makes overlap legible. Capabilities, repository primitives, explicit leases, and exact-head evidence remain authoritative.

## Message normalization

Protocol helpers normalize into one canonical typed event envelope before persistence. IDs, timestamps, destinations, expected-response state, artifacts, patches, and evidence remain attached to the immutable Remote message. Helper shorthand is never a second message schema.

## Public product boundary

The visible **LIVE** terminal makes current work a readable social object. It exposes only sanitized public projections and exact-build snapshots. It never receives private credentials, signatures, administrative controls, nonce records, generic product-sync authority, private message bodies, hidden recode positions, or uncommitted secrets.

## Sources of truth

- Live state: the Remote service and its immutable terminal receipts.
- Static state: the generated exact-build snapshot.
- Durable code/review evidence: Git commits, checks, artifacts, and pull-request discussion.
- Executable collaboration protocol: [`WEAVE_PROTOCOL.md`](./WEAVE_PROTOCOL.md).
- Current implementation boundary: [`WEAVE_STATUS.md`](./WEAVE_STATUS.md).
- Normative collaboration target: [`WEAVE_SPEC.md`](./WEAVE_SPEC.md).
- This file: concise rationale only.

## Completion honesty

A terminal proposal must identify a real 40-character tested Git head. Every required successful check must name that exact head. A deployed production claim is valid only when its receipt names the exact merge SHA. Otherwise production remains explicitly `unverified`.

Merged prose is not runtime evidence. Each beacon, presence, messaging, recode, termination, recovery, or public-projection claim must be grounded in executable code and exact-head proof while extending the existing Remote rather than silently creating a second authority.
