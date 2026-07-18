# Archie hosted founder access

Hosted Archie runs the same `archied` workspace, evidence, artifact, approval, rollback, and portable-export contracts as local Archie. The hosted layer adds private founder access, an outbound-only local runner protocol, and a hardened container boundary; it does not create a second product or a second canonical database.

## Start

Create two distinct private tokens of at least 24 characters, then run:

```bash
export ARCHIED_FOUNDER_TOKEN='replace-with-a-long-private-founder-value'
export ARCHIED_RUNNER_TOKEN='replace-with-a-different-private-runner-value'
docker compose up --build
```

Open `http://localhost:8787` and enter the founder token. Durable hosted workspaces and hybrid queue events live in the `archie-data` volume.

PowerShell:

```powershell
$env:ARCHIED_FOUNDER_TOKEN = 'replace-with-a-long-private-founder-value'
$env:ARCHIED_RUNNER_TOKEN = 'replace-with-a-different-private-runner-value'
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

- The founder and runner tokens are distinct process configuration values.
- A successful browser login exchanges the founder token for a signed, HTTP-only, SameSite=Strict session cookie.
- Hybrid founder APIs use the founder bearer token; polling, heartbeat, completion, and failure APIs use only the runner bearer token.
- Tokens and sessions never enter workspace events, artifacts, exports, queue events, diagnostics, or receipts.
- The public `/health` route reveals only service version, mode, migration level, and readiness.
- Every product, workspace, status, evidence, export, rollback, and hybrid queue route requires its exact authority.
- The hosted gateway strips caller-supplied principal and forwarding headers before injecting the bounded local owner identity into loopback `archied`.
- Cross-site browser mutations are rejected and failed browser login attempts are bounded per source address.

## Outbound-only local runner

A local computer can contribute its real filesystem and compute without exposing an inbound port:

```bash
export ARCHIED_HYBRID_URL='https://archie.example.internal'
export ARCHIED_RUNNER_TOKEN='the-same-distinct-runner-token'
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

The first admitted hybrid job kind is the same explicitly approved standalone product journey already used locally. Arbitrary remote shell execution, hosted inbound callbacks, hidden file reads, spending, contact, deployment, and destructive authority are not part of this protocol.

## Operator status and backup

After browser authentication:

```text
/.well-known/archied.json
/v1/hosted/status
```

The hosted status endpoint shows exact workspace heads, event counts, evidence, approvals, rollback counts, inspection URLs, and portable-export URLs. The founder-only hybrid status endpoint adds the digest-chained queue head, lease state, attempts, completion receipts, and runner identity. A portable `.archie.json` export remains the canonical workspace backup and clean-machine restore path.

## Container boundary

The reference image:

- runs as the unprivileged `node` user;
- writes only to `/data` and a bounded temporary filesystem;
- drops Linux capabilities and enables `no-new-privileges`;
- uses a read-only root filesystem under Compose;
- has no GitHub, Git remote, source-host token, Actions, Pages, or repository identity dependency in its runtime contracts;
- exposes one hosted service and one product surface.

## Truth boundary

This package proves that the same Archie-native product can run locally or behind private hosted founder access, delegate one bounded journey to an outbound-only local runner, reject stale writers, and import an exact portable result. It does not claim that a public deployment currently exists, that arbitrary local work is remotely authorized, that a trained Archie candidate has passed evaluation, that MLX/GGUF is admitted, that physical-device performance has been proven, or that customer value improved. Those claims remain governed by #539, #540, #538, and the real LBTB benchmark.
