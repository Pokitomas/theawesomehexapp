# Sideways Weave Protocol

The weave is a typed collaboration layer over the existing Universal Remote. It does not create a second state ledger, replace the signed remote transport, or expose mutation authority in the consumer UI.

The Remote remains responsible for authentication, append-only storage, cursors, exact-head state, claims, blockers, and terminal generation receipts. The weave gives project-defined meaning to ordinary Remote messages.

## Why it exists

An exclusive scope claim can prevent accidental collision, but it cannot express that collision is wanted. A joining principal also needs a durable way to find unfinished thought, join another participant without taking ownership, announce artifact intent, challenge the current interpretation, recode a surface, and leave recoverable residue before its runtime disappears.

## Event envelope

Every weave event is stored inside the existing Remote message payload:

```json
{
  "summary": "Beacon navigation-opposition: challenge the current navigation premise.",
  "action": "beacon.emit",
  "weave": {
    "protocol": "sideways-weave",
    "version": 1,
    "id": "event-id",
    "kind": "beacon.emit",
    "issuer": "opaque-principal",
    "issued_at": "2026-07-14T14:00:00.000Z",
    "parent": null,
    "body": {}
  }
}
```

Messages remain signed and immutable. Current collaboration state is a projection produced by folding the event stream; it is never independently mutated or treated as canonical.

## Beacons

`beacon.emit` advertises unfinished work. `beacon.join` is intentionally non-exclusive: several principals may join the same beacon. `beacon.release` removes only the releasing participant. `beacon.resolve` records a reasoned outcome and evidence.

Beacon kinds include requests for opposition, parallel implementation, runtime observation, integration, debugging, recoding, collision resolution, and recovery after a participant disappears.

A beacon is not a file lock. Existing Remote claims remain available when temporary exclusivity is actually required.

## Presence and artifact intent

`presence` publishes a renewable runtime lease and current state. Expired leases project a recovery beacon unless a handoff, loss, or recovery event already explains the session.

`intent` declares the reality change an agent is attempting and its collision policy:

- `avoid`
- `compare`
- `deliberately_overlap`
- `integrate_after`

This makes parallel work legible without turning every declaration into ownership.

## Messaging

`message` carries an operational statement with a type, thread, expected response contract, artifacts, and evidence. Agreement without a state change remains unnecessary; important conclusions should become events, patches, tests, or decisions in the durable project surface.

## Recoding

A recode changes the interpretation of the program rather than merely patching inside it.

`recode.declare` records the current reality, proposed reality, rejected assumptions, preserved invariants, blast radius, desired participants, execution mode, and rollback plan. Other principals join with `recode.join`, publish executable progress through `recode.event`, and finish with `recode.terminate`.

A failed recode may terminate as a preserved runnable variant. Failure does not erase the contradiction it discovered.

## Session termination and recovery

`session.handoff` is graceful agent-runtime termination. It releases beacon participation and preserves active work, modified artifacts, uncommitted changes, beliefs, unresolved concerns, and recommended next actions.

`session.lost` records unexpected disappearance. `session.recover` identifies who reconstructed the work and whether it was continued, packaged, reverted, or declared unrecoverable.

These events do not terminalize the whole Remote generation. Whole-generation completion still uses the existing exact-head proposal and terminal receipt protocol.

## CLI

`scripts/weave-client.mjs` emits typed events through the signed Remote API and can fold returned messages into current weave state.

Examples:

```bash
node scripts/weave-client.mjs beacon beacon.json
node scripts/weave-client.mjs join navigation-opposition "Building a blind alternate navigation"
node scripts/weave-client.mjs presence coding 300
node scripts/weave-client.mjs intent intent.json
node scripts/weave-client.mjs recode recode.json
node scripts/weave-client.mjs handoff handoff.json
node scripts/weave-client.mjs state --private
```

The client requires the same `REMOTE_URL`, `REMOTE_SESSION`, `REMOTE_PRINCIPAL`, and signing-key environment used by the Universal Remote client. `WEAVE_SESSION_ID` names the current runtime session for presence and handoff events.

## Product boundary

The visible LIVE surface may render sanitized public summaries. It must not receive signing keys, private payloads, nonce records, grants, administrative controls, or generic mutation authority. The collaboration architecture remains an implementation substrate rather than product mythology.
