# Archie hosted founder access

Hosted Archie runs the same `archied` workspace, evidence, artifact, approval, rollback, and portable-export contracts as local Archie. The hosted layer adds private founder/developer authentication and a hardened container boundary; it does not create a second product or a second canonical database.

## Start

Create a private token of at least 24 characters, then run:

```bash
export ARCHIED_FOUNDER_TOKEN='replace-with-a-long-private-random-value'
docker compose up --build
```

Open `http://localhost:8787` and enter that token. Durable state lives in the `archie-data` volume.

PowerShell:

```powershell
$env:ARCHIED_FOUNDER_TOKEN = 'replace-with-a-long-private-random-value'
docker compose up --build
```

## Private URL

For a private reverse proxy or managed container host, set the exact external origin:

```bash
export ARCHIED_PUBLIC_ORIGIN='https://archie.example.internal'
export ARCHIED_COOKIE_SECURE='true'
docker compose up --build
```

Terminate TLS at the host or reverse proxy. Keep the container port private. Direct host binding defaults to `127.0.0.1`; set `ARCHIED_BIND=0.0.0.0` only when a firewall or trusted private network already protects the port.

No paid host, domain, certificate, or external account is created by this repository.

## Authentication boundary

- The founder token is read from process configuration only.
- A successful login exchanges it for a signed, HTTP-only, SameSite=Strict session cookie.
- The token and session never enter workspace events, artifacts, exports, diagnostics, or receipts.
- The public `/health` route reveals only service version, mode, migration level, and readiness.
- Every product, workspace, status, evidence, export, and rollback route requires authentication.
- The gateway strips caller-supplied principal and forwarding headers before injecting the bounded local owner identity into loopback `archied`.
- Cross-site mutations are rejected.
- Failed login attempts are bounded per source address.

## Operator status and backup

After authentication:

```text
/.well-known/archied.json
/v1/hosted/status
```

The status endpoint shows exact workspace heads, event counts, evidence, approvals, rollback counts, inspection URLs, and portable-export URLs. A portable `.archie.json` export is the canonical backup and clean-machine restore path for this tranche.

## Container boundary

The reference image:

- runs as the unprivileged `node` user;
- writes only to `/data` and a bounded temporary filesystem;
- drops Linux capabilities and enables `no-new-privileges`;
- uses a read-only root filesystem under Compose;
- has no GitHub, Git remote, source-host token, or network dependency in its domain contracts;
- exposes one service and one product surface.

## Truth boundary

This package proves that the same Archie-native product can run locally or behind private hosted founder access. It does not claim that a public deployment currently exists, that a trained Archie candidate has passed evaluation, that MLX/GGUF is admitted, or that physical-device performance has been proven. Those claims remain governed by #539, #540, and #538.
