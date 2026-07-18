# Hosted Archie parity

Hosted mode runs the same `archied` workspace engine and product surface as local mode. It changes transport, private authentication, stable URLs, shares, secret storage, and backup operations; it does not create a second canonical domain model.

## Start without buying or creating an external service

```bash
cp .env.archied.example .env.archied
# Replace every placeholder with locally generated values.
docker compose up --build
```

The reference stack binds to `127.0.0.1:8787` by default. Put an HTTPS reverse proxy in front before changing the bind address for network access. `ARCHIED_PUBLIC_URL` is the stable external base URL written into inspection, export, and share receipts; it is not inferred from caller-supplied forwarding headers.

Hosted startup fails closed unless it receives:

- distinct SHA-256 digests for founder and developer access tokens;
- a separate 32-byte HMAC session-signing key;
- a separate 32-byte AES-256-GCM secret-store key;
- an HTTPS public URL, except when `ARCHIED_ALLOW_INSECURE_HOSTED=1` is explicitly set for an isolated test.

The raw access tokens and cryptographic keys are runtime configuration only. They are never written into the image, workspace event stream, product artifact, descriptor, share registry, or backup.

## Private access

Open `/login` and enter either original raw access token. A successful login creates a signed, HTTP-only, SameSite=Strict session. API clients may use the same raw token as a bearer credential.

- Founder maps to the existing `owner_local` principal so local and hosted workspaces retain identical authority semantics.
- Developer maps to `developer_local`, can create and operate their own workspaces, and cannot inspect a founder's private workspace without an explicit grant.
- Only the founder can run the pre-authorized standalone promotion journey, change encrypted secret configuration, or create a full service backup.

The unauthenticated `/health` endpoint exposes only liveness, hosted mode, service version, and migration level. The product surface, full descriptor, stable workspace URLs, workspace APIs, operational status, exports, secrets metadata, and backups require authentication. Cross-site mutations are denied and failed login attempts are bounded per source address.

## Explicit read-only shares

A workspace owner can create an expiring share:

```http
POST /v1/hosted/shares
Authorization: Bearer <raw-owner-token>
Content-Type: application/json

{"workspace_id":"workspace_...","expires_in_ms":86400000}
```

Archie registers a dedicated share principal and records an exact read-only capability grant in the workspace event stream. The returned URL discloses a random token once; only its SHA-256 digest is persisted. Resolving `/share/<token>` returns the workspace projection only. It cannot execute commands, export artifact bytes, issue another share, or outlive its registry and workspace-grant expiration. Revocation removes the workspace grant and marks the registry record revoked.

## Encrypted secret configuration

```http
PUT /v1/hosted/secrets/provider_api
Authorization: Bearer <raw-founder-token>
Content-Type: application/json

{"value":"secret material"}
```

The response contains the secret name, key identifier, and update time only. The durable store uses a new random nonce for each write, AES-256-GCM authentication, and name-bound additional authenticated data. Founder status may list configured names; developer status exposes only the count. Neither route returns plaintext or ciphertext.

## Backups and operational visibility

`POST /v1/hosted/backups` creates one integrity-checked service backup inside the persistent Archie volume. It contains every digest-chained workspace event, every admitted artifact byte, and the encrypted secret envelope. It intentionally excludes raw tokens and the external session and encryption keys. `/v1/hosted/status` reports the authenticated principal, visible workspace heads, evidence/approval/rollback counts, share-registry digest, secret metadata, migration level, and latest backup digest without exposing local filesystem paths.

The encryption key must be preserved separately from the backup. A backup without that key still restores workspace history and artifact bytes, but not secret plaintext.

## Container boundary

The OCI image runs as the unprivileged `node` user. The Compose stack uses a read-only root filesystem, a bounded temporary filesystem, a named durable volume, dropped Linux capabilities, and `no-new-privileges`. The image includes no GitHub credential, Git remote identity, raw Archie access token, encryption key, or vendor-specific deployment contract.

## Hard boundary

A green hosted-parity receipt proves private founder/developer authentication, provider-neutral HTTP parity, stable workspace URLs, explicit read-only shares, encrypted secret configuration, operational visibility, backup integrity, container packaging, and restart durability. It does not prove that an external deployment exists, that a third-party TLS endpoint is configured, that a trained Archie candidate is admitted, that a native device backend works, or that customer outcomes improved.
