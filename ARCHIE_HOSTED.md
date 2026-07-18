# Archie hosted authority

Hosted Archie runs the same `archied` workspace, evidence, artifact, approval, rollback, Maker journey, and portable-export contracts as local Archie. The hosted layer changes private transport and operations; it does not create a second product, domain model, or canonical database.

## Private hosted parity

Generate two long raw tokens, store them in a password manager, and place only their SHA-256 digests plus two independent 32-byte keys in `.env.archied` using `.env.archied.example`.

```bash
cp .env.archied.example .env.archied
# replace every placeholder locally
docker compose -f compose.hosted.yaml up --build
```

The reference stack binds to `127.0.0.1:8787`. It does not buy or create an external service. For remote access, place an HTTPS reverse proxy or private platform ingress in front and set `ARCHIED_PUBLIC_URL` to the stable external base URL. Hosted startup fails closed on plain HTTP unless `ARCHIED_ALLOW_INSECURE_HOSTED=1` is explicitly set for an isolated test.

The same image also contains the portable-workspace hybrid gateway used by `compose.yaml`; that path adds bounded local execution but does not replace these hosted workspace and authority contracts.

## Roles

- `owner_local` / founder can run the explicitly approved product journey, manage shares, enroll bounded local runners, offer exact native tasks, write encrypted provider configuration, create full backups, inspect owned workspaces, export, approve, and roll back.
- `developer_local` / developer authenticates independently and sees only public workspaces or workspaces that explicitly grant that principal access. Developer authority cannot silently inherit founder ownership or runner-enrollment authority.

Browser login exchanges the supplied token for an independently signed HTTP-only, SameSite=Strict session. API clients may use the raw token as a bearer credential. Only token digests are configured or compared; raw tokens never enter workspace events, artifacts, Maker receipts, backups, exports, status, or the container image.

## Stable workspace URLs

Every workspace has a provider-neutral product URL:

```text
/w/{workspace_id}
```

The authenticated URL opens the same responsive Archie client and exact native state. GitHub is not needed to inspect progress, evidence, approval, rollback, or exports.

## Bounded outbound runners

Hosted Archie exposes two complementary outbound-only paths:

- The portable-workspace queue runner leases one pre-authorized standalone journey, heartbeats its fenced queue lease, and returns a fully verified Archie bundle for serialized admission.
- The enrolled runner uses a single-use enrollment token, advertises exact resources and privacy, claims one existing native task, streams digest-bound events, uploads only explicitly admitted artifacts, and records native terminal success or failure receipts.

Neither process opens a local listener. Both deny contact, spending, deployment, publishing, arbitrary networking, credential transfer, and writes outside the leased boundary. See `ARCHIE_ENROLLED_HYBRID_RUNNER.md` for the fine-grained task protocol.

## Expiring read-only shares

A workspace owner may issue a one-time-disclosed share URL:

```http
POST /v1/hosted/shares
Content-Type: application/json

{"workspace_id":"workspace_...","expires_in_ms":3600000,"label":"Review-only evidence share"}
```

Archie creates an exact share principal and a `read` capability grant. The durable registry stores only the token digest. Share resolution rechecks native workspace authority, expiry, and revocation. It cannot execute commands, export, create another share, change secrets, create backups, spend, contact, publish, or deploy.

List and revoke shares through:

```text
GET  /v1/hosted/workspaces/{workspace_id}/shares
POST /v1/hosted/workspaces/{workspace_id}/shares/{share_id}/revoke
```

## Encrypted configuration

Only the founder can write hosted provider/configuration secrets:

```http
PUT /v1/hosted/secrets/provider_api
Content-Type: application/json

{"value":"secret material"}
```

Values are encrypted independently with AES-256-GCM, random nonces, authentication tags, and secret-name-bound additional authenticated data. Status reports counts and, for the founder, names and timestamps; it never exposes values or ciphertext. The external encryption key must be backed up separately.

## Backups and operational status

`POST /v1/hosted/backups` creates a digest-verified full service backup under the persistent Archie volume. It contains every verified native workspace event, admitted artifact byte, and the encrypted secret envelope. It intentionally excludes raw access tokens plus session and encryption keys.

`GET /v1/hosted/status` reports service version, migration level, workspaces visible to the authenticated principal, share-registry identity, encrypted-secret metadata, both runner-path summaries, backup count, and latest backup digest without disclosing host filesystem paths.

## Container boundary

The reference stack uses one unprivileged Node process, a read-only root filesystem, bounded temporary storage, dropped Linux capabilities, `no-new-privileges`, a persistent Archie data volume, and loopback-only publication by default. It contains no GitHub credential, Git remote identity, provider account, or vendor-specific deployment contract.

## Hard boundary

A green hosted-parity receipt proves private founder/developer authentication, explicit native grants, stable URLs, read-only shares, encrypted configuration, backup integrity, outbound-runner boundaries, container packaging, and restart durability. It does not prove that an external deployment exists, that third-party TLS is configured, that a trained Archie candidate is admitted, that a native device backend works, or that customer outcomes improved.
