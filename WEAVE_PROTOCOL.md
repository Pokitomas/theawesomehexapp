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

Messages remain signed and immutable. Current collaboration state is a projection produced by folding the event stream; it is never independently mutated or treated as canonical. Beacon and presence events default public so other participants can discover them. Operational messages, recodes, session handoffs, loss records, and recovery residue default private unless the sender explicitly marks them public.

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

## Automatic co-agent lasso

There are two arrival paths.

### GitHub arrivals

`scripts/weave-lasso.mjs` observes incoming GitHub issues, comments, pull requests, and reviews through `.github/workflows/weave-lasso.yml`. When Remote credentials are configured, the workflow silently records the arrival in private weave messages and groups the principal into shared ontology assemblies.

### Direct Remote arrivals

`netlify/functions/weave-lasso-service.mjs` runs inside the authenticated Remote write path. A new opaque principal is grouped immediately after its original message is durably stored. The lasso writes private internal messages under `system:weave-lasso`, never recursively lassos its own messages, and never blocks or changes the response to the authenticated write if grouping fails.

The backend lasso is enabled automatically in the Netlify runtime. `REMOTE_WEAVE_LASSO=1` explicitly enables it elsewhere; `REMOTE_WEAVE_LASSO=0` disables it.

The lasso does not assign a coding ticket. Every arrival enters the two foundational rooms:

- **program execution** — what actually happens from source to authority to candidate to ranking to rendering to interaction and moderation
- **corpus boundaries** — separation of the public social graph, private personal archive, ranking candidate pool, retrieval index, and starter fixture

A third room is selected from the arrival’s context: social substrate, conversation model, ranking legitimacy, identity and community, or governance and abuse.

Rooms are stable threads. A second participant triggers an adversarial round asking each participant for a concrete model, a contradiction, an executable probe, and one deletion candidate. Deterministic event and message identifiers make repeated deliveries idempotent instead of generating chatter storms.

The foundational object distinctions and current product claim are recorded in [`PROGRAM_ONTOLOGY.md`](./PROGRAM_ONTOLOGY.md). Assemblies are expected to attack that document, not treat it as doctrine.

## Recursive cognition

The recursive weave adds a typed cognition stream without replacing the signed Remote ledger. Its canonical state is the deterministic fold of immutable claims, evidence, contradictions, questions, goals, plans, decisions, tests, artifacts, uncertainty, assignments, syntheses, critiques, supersessions, and wave receipts.

Agents and model adapters are replaceable inference organs. They receive bounded provenance-preserving memory packets and typed role assignments. Their outputs are advisory candidates until schema validation, citation checks, synthesis, and an independent critic receipt admit them into the cognition stream.

One finite wave executes:

`observe → retrieve → propose → oppose → test → synthesize → critique → plan → dispatch → observe`

A later wave may be derived only from unresolved folded state. Identical events and configuration must yield identical state, retrieval, assignments, and receipts. Contradiction and minority reports remain first-class; confidence is metadata rather than a vote.

Every run has explicit limits for waves, events, assignments, open questions, and memory size. Terminal states are `converged`, `blocked`, `budget_exhausted`, `invalid_state`, or `human_required`. Duplicate delivery and retry must not duplicate dispatch or canonical output.

The durable stream stores concise claims, evidence, decisions, uncertainty, dissent, and rationale receipts. It must never persist private chain-of-thought, hidden scratchpads, credentials, raw prompts, or generic future fields.

No adapter or recursive workflow receives authority to merge, deploy, grant capabilities, administer the Remote, or mutate canonical state outside typed authenticated events. Secret-bearing or write-capable execution must use trusted default-branch code and least-privilege permissions.

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
