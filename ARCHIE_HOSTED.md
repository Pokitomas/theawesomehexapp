# Hosted Archie authority and hybrid runner

Hosted Archie runs the same `archied` workspace, evidence, artifact, approval, rollback, and portable-export contracts as local Archie. The hosted layer adds private founder/developer access, explicit read-only sharing, encrypted configuration, full service backups, an outbound-only local runner protocol, and a hardened container boundary. It does not create a second product or canonical database.

## Start without buying or creating an external service

```bash
cp .env.archied.example .env.archied
# Replace every placeholder with locally generated values.
docker compose up --build
```

The reference stack binds to `127.0.0.1:8787` by default. Put an HTTPS reverse proxy in front before changing the bind address for network access. `ARCHIED_PUBLIC_URL` is the stable external base URL written into inspection, export, share, and hybrid receipts; it is never inferred from caller-supplied forwarding headers.

Hosted startup fails closed unless it receives:

- distinct SHA-256 digests for founder and developer access tokens;
- a separate 32-byte HMAC session-signing key;
- a separate 32-byte AES-256-GCM secret-store key;
- a third distinct raw runner token;
- an HTTPS public URL, except when `ARCHIED_ALLOW_INSECURE_HOSTED=1` is explicitly set for an isolated test.

The original founder and developer tokens are entered by humans or sent as bearer credentials, but only their digests are configured. Raw browser/API tokens, session keys, encryption keys, and runner credentials never enter workspace events, artifacts, exports, queue events, diagnostics, shares, or backups.

## Founder and developer access

Open `/login` and enter either original raw access token. A successful login creates a signed, HTTP-only, SameSite=Strict session. API clients may use the same raw token as a bearer credential.

- Founder maps to `owner_local`, preserving local and hosted authority semantics.
- Developer maps to `developer_local`, can create and operate their own workspaces, and cannot inspect a founder-private workspace without an explicit grant.
- Only the founder can run the pre-authorized standalone promotion journey, create hybrid jobs, change encrypted secret configuration, or create a full service backup.

The unauthenticated `/health` route exposes liveness, hosted mode, service version, and migration level only. Product, descriptor, workspace, status, evidence, export, rollback, secret, backup, and hybrid queue routes require their exact authority. Cross-site browser mutations are rejected and failed login attempts are bounded per source address.

## Explicit read-only shares

A workspace owner can create an expiring share:

```http
POST /v1/hosted/shares
Authorization: Bearer <raw-owner-token>
Content-Type: application/json

{"workspace_id":"workspace_...","expires_in_ms":86400000}
```

Archie registers a dedicated share principal and records an exact `read` capability grant in the workspace event stream. The returned URL discloses a random token once; only its SHA-256 digest is persisted. Resolving `/share/<token>` returns the workspace projection only. It cannot execute commands, export artifact bytes, create another share, or outlive the registry and workspace-grant expiration. Revocation removes the native grant and marks the registry receipt revoked.

## Encrypted secret configuration

```http
PUT /v1/hosted/secrets/provider_api
Authorization: Bearer <raw-founder-token>
Content-Type: application/json

{"value":"secret material"}
```

The response contains the secret name, key identifier, and update time only. The durable store uses a fresh random nonce for each write, AES-256-GCM authentication, and secret-name-bound additional authenticated data. Founder status may list configured names; developer status exposes only the count. Neither route returns plaintext or ciphertext.

## Outbound-only local runner

A local computer contributes its real filesystem and compute without exposing an inbound port:

```bash
export ARCHIED_HYBRID_URL='https://archie.example.internal'
export ARCHIED_RUNNER_TOKEN='the-distinct-runner-token-from-hosted-config'
export ARCHIED_RUNNER_ID='my-local-runner'
npm run archie:runner
```

The runner opens no listener. It polls outward, leases one compatible job, executes the bounded local Maker journey under its own `ARCHIE_HOME`, heartbeats an expiring lease, and returns an integrity-checked portable workspace. Hosted Archie verifies every event and artifact digest before import.

Each lease carries a monotonically increasing fencing token. If a runner disappears, the lease expires and the job may be reclaimed. Any late heartbeat, failure, or completion from the stale lease is rejected. Founder cancellation is terminal.

Founder queue API:

```text
GET  /v1/hybrid/descriptor
GET  /v1/hybrid/status
POST /v1/hybrid/jobs
GET  /v1/hybrid/jobs/{job_id}
POST /v1/hybrid/jobs/{job_id}/cancel
```

Runner API:

```text
POST /v1/hybrid/lease
POST /v1/hybrid/jobs/{job_id}/heartbeat
POST /v1/hybrid/jobs/{job_id}/complete
POST /v1/hybrid/jobs/{job_id}/fail
```

The first admitted hybrid job kind is the explicitly approved standalone product journey already used locally. Arbitrary remote shell execution, hosted inbound callbacks, hidden file reads, spending, contact, deployment, and destructive authority are not part of this protocol.

## Status and backups

After browser or bearer authentication:

```text
/.well-known/archied.json
/v1/hosted/status
/v1/hybrid/status
```

Hosted status reports the authenticated principal, visible workspace heads, event counts, evidence, approvals, rollback counts, stable inspection/export URLs, share-registry digest, secret metadata, migration level, and latest backup digest. Developer status is filtered to the developer's native authority.

`POST /v1/hosted/backups` creates an integrity-checked service backup in the persistent Archie volume. It contains every digest-chained workspace event, every admitted artifact byte, and the encrypted secret envelope. It excludes founder, developer, and runner tokens plus the external session and encryption keys. The encryption key must be preserved separately; without it, workspace history and artifact bytes remain restorable but secret plaintext does not.

Portable `.archie.json` workspace exports remain the smaller ownership and clean-machine restore path.

## Container boundary

The reference image:

- runs as the unprivileged `node` user;
- writes only to `/data` and a bounded temporary filesystem;
- drops Linux capabilities and enables `no-new-privileges`;
- uses a read-only root filesystem under Compose;
- has no GitHub, Git remote, source-host token, Actions, Pages, or repository identity dependency in its runtime contracts;
- exposes one hosted service and one product surface.

## Hard boundary

A green hosted-parity receipt proves private founder/developer authentication, stable provider-neutral URLs, explicit read-only shares, encrypted secret configuration, operational visibility, full backup integrity, hardened container packaging, outbound-only hybrid execution, stale-writer rejection, and verified portable import. It does not prove that an external deployment exists, third-party TLS is configured, arbitrary local work is remotely authorized, a trained Archie candidate is admitted, a native device backend works, physical-device performance is proven, or customer outcomes improved.
