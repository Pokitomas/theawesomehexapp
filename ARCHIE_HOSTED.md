# Hosted Archie parity

Hosted mode runs the same `archied` workspace engine and product surface as local mode. It changes transport, authentication, stable URLs, secret storage, shares, and backup operations; it does not create a second domain model.

## Start without buying or creating an external service

```bash
cp .env.archied.example .env.archied
# Replace every placeholder with locally generated values.
docker compose -f compose.archied.yml up --build
```

The default Compose binding is `127.0.0.1:8787`. Put an HTTPS reverse proxy in front before changing the bind address for network access. `ARCHIED_PUBLIC_URL` is the stable external base URL written into workspace and share receipts; it is not inferred from untrusted request headers.

Hosted startup fails closed unless it receives:

- distinct SHA-256 token digests for `founder` and `developer` credentials;
- a 32-byte share-signing key;
- a different 32-byte AES-256-GCM secret-store key;
- an HTTPS public URL, except when `ARCHIED_ALLOW_INSECURE_HOSTED=1` is explicitly set for a local test.

The raw tokens and encryption keys are injected at runtime and are never written into the image, descriptor, workspace event stream, share token payload, or backup. The encrypted configuration store lives inside the persistent Archie volume. Its encryption key must be backed up separately.

## Access

Basic authentication works directly in a browser:

- username `founder`, password equal to the original founder token;
- username `developer`, password equal to the original developer token.

API clients may instead use the original token as a bearer credential. Only the founder can run the pre-authorized standalone promotion journey, change encrypted secret configuration, or create a full backup. Developers may use ordinary workspace APIs under their own principal and can only read workspaces that explicitly grant them access.

The unauthenticated `/health` endpoint exposes liveness, service version, migration level, and mode only. The product surface, full descriptor, stable workspace URLs, workspace APIs, operational status, exports, secrets metadata, and backups require authentication.

## Explicit read-only shares

An authenticated principal with read access can create an expiring share:

```http
POST /v1/hosted/shares
Authorization: Bearer <token>
Content-Type: application/json

{"workspace_id":"workspace_...","expires_in_ms":86400000}
```

The returned signed URL permits only the exact read projection. It cannot execute workspace commands, export artifacts, create another share, or outlive its expiration. If the issuing principal loses workspace read authority, the share stops resolving.

## Encrypted secret configuration

```http
PUT /v1/hosted/secrets/provider_api
Authorization: Bearer <founder-token>
Content-Type: application/json

{"value":"secret material"}
```

The response contains only the secret name, key identifier, and update time. `/v1/hosted/status` lists configured names but never values or ciphertext. The durable file uses per-secret random nonces, AES-256-GCM authentication tags, and name-bound additional authenticated data.

## Backups and visibility

`POST /v1/hosted/backups` creates an integrity-checked Archie backup inside the persistent volume. It contains every digest-chained workspace event, admitted artifact byte, and the encrypted secret envelope. It intentionally excludes the external encryption key. `/v1/hosted/status` reports workspace count, secret names, migration level, backup count, and the latest backup digest without exposing local filesystem paths.

## Container boundary

The reference stack runs one unprivileged Node process, drops Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem, bounds temporary storage, and writes durable state only to the Archie volume. The image contains no token, encryption key, GitHub credential, Git remote identity, or vendor-specific deployment contract.

## Hard boundary

A green hosted-parity receipt proves private authentication, provider-neutral HTTP parity, stable URLs, explicit shares, encrypted configuration, operational visibility, backup integrity, container packaging, and restart durability. It does not prove that an external deployment exists, that TLS has been configured by a third party, that a trained Archie candidate is admitted, that a native device backend works, or that customer outcomes improved.
