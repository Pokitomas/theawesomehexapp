# Sideways Universal Remote

The remote is a vendorless project control surface. It transports signed messages, keeps an append-only cursorable log, exposes optional expiring claims, emits a small CI decision, and can write an immutable exact-head terminal receipt. It does not assign model roles or prescribe collaboration.

## Public discovery

Programs can discover the live projection from:

```text
/.well-known/sideways-remote.json
```

The consumer app exposes the same public state through the **LIVE** button and `window.SidewaysRemote`. The browser receives only public projections. Credentials, private payloads, signatures, and administrative controls never enter consumer code.

The discovery manifest also exposes stable weaving pointers:

- `REMOTE_WORK.md` — where a joining principal starts and finds the live report surfaces.
- `REMOTE_THOUGHT.md` — shareable rationale and boundaries, not private reasoning or live state.
- the active GitHub pull-request conversation — durable discussion and evidence.

```js
await window.SidewaysRemote.refresh();
window.SidewaysRemote.state();
window.addEventListener('sideways:remoteupdate', event => console.log(event.detail));
```

Public HTTP reads:

```text
GET /api/remote/state?session=<session>&public=1
GET /api/remote?session=<session>&after=<cursor>&public=1
```

## Signed requests

Bootstrap credentials use generic environment variables:

```text
REMOTE_ROOT_ID
REMOTE_ROOT_KEY
REMOTE_PUBLIC_SESSION
```

Additional principals should use Ed25519 keypairs. The server stores only their public keys and capabilities. A root-capable request can grant or revoke a principal record. Private keys stay with the participant.

Every authenticated request signs:

```text
HTTP_METHOD
REQUEST_PATH_AND_QUERY
ISO_TIMESTAMP
SINGLE_USE_NONCE
SHA256(BODY)
```

Headers:

```text
x-remote-principal
x-remote-timestamp
x-remote-nonce
x-remote-signature
x-remote-path
```

The service rejects stale timestamps, reused nonces, unknown or expired principals, bad signatures, insufficient capabilities, duplicate message IDs, and stale session generations.

## Message envelope

```json
{
  "message": {
    "id": "globally-unique-id",
    "session": "project-defined-session",
    "generation": 1,
    "issuer": "opaque-principal-id",
    "parent": null,
    "issued_at": "2026-07-14T03:00:00.000Z",
    "expires_at": null,
    "head_sha": "optional-exact-head",
    "scope": ["opaque:scope"],
    "payload": {
      "action": "Any project-defined instruction",
      "summary": "Optional public terminal summary"
    },
    "visibility": "private",
    "nonce": "same-single-use-nonce-as-header"
  }
}
```

The payload is open-ended. `visibility: "public"` opts the message into the read-only live terminal.

## Mechanical controls

Controls are optional and narrowly mechanical:

```json
{ "control": { "op": "claim", "scope": "repo:branch:feature", "ttl_seconds": 1200 } }
{ "control": { "op": "release", "scope": "repo:branch:feature" } }
{ "control": { "op": "pause" } }
{ "control": { "op": "resume" } }
{ "control": { "op": "stop" } }
{ "control": { "op": "set-head", "head_sha": "..." } }
{ "control": { "op": "block", "id": "blocker-id", "summary": "..." } }
{ "control": { "op": "unblock", "id": "blocker-id" } }
{ "control": { "op": "propose-terminal", "evidence": {} } }
{ "control": { "op": "terminalize" } }
{ "control": { "op": "new-generation" } }
```

Claims are optional, scope-opaque, expiring, renewable, and releasable. They never prescribe turns.

## CLI

```bash
export REMOTE_URL='https://your-site.netlify.app'
export REMOTE_SESSION='Pokitomas/theawesomehexapp:work-1'
export REMOTE_PRINCIPAL='local-tool'
export REMOTE_KEY='generic-bootstrap-secret'

npm run remote -- state
npm run remote -- send '{"payload":{"action":"inspect the phone build","summary":"Phone inspection started"},"visibility":"public"}'
npm run remote -- claim repo:branch:feature 1200
npm run remote -- release repo:branch:feature
```

Ed25519 users set `REMOTE_PRIVATE_KEY` to a PEM string or `@path/to/private-key.pem` instead of `REMOTE_KEY`.

## CI gate

`scripts/remote-gate.mjs` emits standard GitHub Actions outputs:

```text
decision=proceed|pause|stop|superseded|terminal
reason=<digestible-summary>
session=<session>
generation=<number>
head_sha=<optional-head>
```

When no remote is configured, the gate proceeds. Native GitHub concurrency remains authoritative for cancelling superseded runs.

## Completion

A terminate-capable principal may propose exact-head evidence. An admin-capable principal may write the terminal receipt only when:

- required checks all report success and each names the exact tested 40-character Git head,
- at least one artifact identifier or digest is present,
- temporary test record count is zero,
- active blocker count is zero,
- no live claims remain,
- the tested head matches the session head,
- merge state is `merged` with a 40-character merge SHA,
- production is explicitly `deployed` with a receipt that names the merge SHA, or `unverified`.

A terminal generation is immutable. More work requires `new-generation` or a new session.
