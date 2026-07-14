# Sideways Universal Remote

The remote is a small project control surface for any temporary principal: a human, a model, CI, a local script, or future software. It transports and records messages and state without assigning companies, model names, permanent roles, or a collaboration ritual.

## Discovery and weaving

During repository work:

- `REMOTE_WORK.md` is the current human report.
- `remote/THOUGHT.md` contains concise shareable rationale, open questions, and next probes.
- `remote/session.json` is the machine-readable bootstrap pointer.
- The active pull-request conversation is the durable discussion surface.

In the running product:

- the **LIVE** button opens a read-only current-work terminal;
- the document advertises the public JSON projection through a `<link rel="alternate" type="application/json">` element;
- `window.SidewaysRemoteTerminal.endpoint()` returns the projection URL;
- `sideways:remoteupdate` fires after the terminal receives state.

The browser receives no remote credential and has no mutation authority.

## HTTP surface

```text
POST /api/remote
GET  /api/remote?session=<session>&after=<cursor>&limit=<n>
GET  /api/remote/state?session=<session>
GET  /api/remote/state?session=<session>&public=1
```

The message log is append-only. Retrieval is ordered and cursor based. Messages are private unless their sender explicitly sets `visibility: "public"`.

## Generic envelope

The remote does not interpret project intelligence inside `payload`.

```json
{
  "op": "message",
  "session": "project/session",
  "generation": 1,
  "message": {
    "id": "globally-unique-id",
    "session": "project/session",
    "generation": 1,
    "issuer": "opaque-principal-id",
    "parent": null,
    "issued_at": "2026-07-14T04:00:00.000Z",
    "expires_at": null,
    "head_sha": "optional-exact-head",
    "scope": ["opaque:project:scope"],
    "visibility": "public",
    "payload": {
      "action": "inspect the current phone build and repair material regressions"
    }
  }
}
```

## Capabilities

Capabilities are attached to principals, never to vendors or model classes.

```text
read write claim release pause resume terminate admin
repo:read repo:write ci:read ci:run deploy:read deploy:write
```

A root credential can open sessions, grant or revoke principals, change generations, and finalize a valid terminal proposal. A replacement participant can receive the same capabilities and continue from the last cursor.

## Authentication

Current deployment uses generic HMAC credentials:

```text
REMOTE_ROOT_KEY
REMOTE_KEY_<NORMALIZED_KEY_ID>
REMOTE_CAPS_<NORMALIZED_KEY_ID>
```

For example, key ID `local-tool.1` resolves to `REMOTE_KEY_LOCAL_TOOL_1` and `REMOTE_CAPS_LOCAL_TOOL_1`.

Every protected request supplies:

```text
x-remote-principal
x-remote-key-id
x-remote-timestamp
x-remote-nonce
x-remote-signature
```

The signature is HMAC-SHA256 over:

```text
HTTP_METHOD
REQUEST_PATH
TIMESTAMP
NONCE
SHA256(BODY)
```

Requests with stale timestamps, reused nonces, unknown or expired principals, invalid signatures, invalid generations, or insufficient capabilities are rejected. Private keys are environment configuration only; never put them in repository files, browser code, logs, issue comments, or chat.

The engine isolates verification from transport so public-key verification can replace HMAC later without changing sessions, messages, claims, cursors, or terminal receipts.

## Command-line client

Set credentials only in the local process environment:

```bash
export REMOTE_URL="https://your-site.example"
export REMOTE_SESSION="theawesomehexapp/universal-remote"
export REMOTE_GENERATION="1"
export REMOTE_PRINCIPAL="local-tool-1"
export REMOTE_KEY_ID="local-tool-1"
export REMOTE_KEY="set-this-outside-the-repository"
```

Public state requires no credential:

```bash
node scripts/remote-client.mjs public-state
```

Protected state and cursor retrieval:

```bash
node scripts/remote-client.mjs state
node scripts/remote-client.mjs messages
node scripts/remote-client.mjs messages '<cursor>'
```

Post any project-defined operation or message:

```bash
node scripts/remote-client.mjs post @message.json
cat message.json | node scripts/remote-client.mjs post -
```

The client deliberately accepts generic JSON rather than forcing a collaboration vocabulary.

## Sessions and claims

A session has an integer generation. A terminal generation cannot silently resume; further work requires `new_generation` with exactly the next integer.

Claims are optional and opaque:

```json
{
  "op": "claim",
  "session": "project/session",
  "generation": 1,
  "scope": "repo:branch:agent/frontier",
  "expires_at": "2026-07-14T20:00:00.000Z"
}
```

Claims expire automatically, can be renewed by re-claiming, can be released, and never apply to independent read-only work.

## CI gate

`scripts/remote-gate.mjs` reads the public session projection and emits ordinary GitHub Actions outputs:

```text
decision=proceed
decision=pause
decision=stop
decision=superseded
decision=terminal
```

The Pages workflow has a dedicated `remote_gate` job. The expensive build job uses `needs` and `if`; a stopped gate does not merely end one shell step while later work continues. Existing GitHub concurrency cancellation remains intact.

Repository variables:

```text
REMOTE_URL
REMOTE_SESSION
REMOTE_GENERATION
REMOTE_REQUIRED
```

When the remote is not configured, CI proceeds normally. When configured but temporarily unavailable, it also proceeds unless `REMOTE_REQUIRED=1`.

## Completion

A principal with `terminate` may propose exact-head completion. The proposal must include successful checks on that head, artifact identifiers or digests, zero temporary records, zero blockers, no active mutation claim, a consistent merged state, and an honest production state.

A root-capable principal may terminalize only after those predicates pass. The immutable receipt contains:

```json
{
  "session": "session-id",
  "generation": 1,
  "head_sha": "exact-tested-head",
  "merge_sha": "merged-commit",
  "evidence": {},
  "production": {
    "state": "deployed-or-unverified",
    "receipt": null
  },
  "terminated_at": "ISO timestamp",
  "terminated_by": "opaque-principal-id"
}
```

A production state of `deployed` is rejected unless its receipt names the merge commit.

## Product boundary

The remote is not social-data sync and does not own the consumer corpus. The live terminal receives only an explicit read-only public projection. Existing ranking, IndexedDB schema ownership, atomic compatibility ledger, worker hashing, viewport media hydration, durability reporting, profile/starter services, and destructive cleanup remain separate and authoritative in their existing layers.
