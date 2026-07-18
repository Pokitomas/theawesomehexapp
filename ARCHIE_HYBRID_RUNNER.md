# Archie outbound hybrid runner

The hybrid runner lets a private local machine execute bounded work for a hosted Archie workspace without opening an inbound port or exposing the machine, its credentials, or its model state.

The hosted service remains the authority for objectives, task state, principals, grants, leases, events, artifacts, evidence, review, approval, and rollback. The local runner is a narrowly admitted Maker executor.

## Operating sequence

A founder first creates a short-lived, single-use enrollment token:

```http
POST /v1/hybrid/founder/enrollments
Content-Type: application/json
X-Archie-CSRF: <session csrf>

{
  "expires_in_seconds": 600,
  "required_protocol_version": "1.0.0",
  "required_capabilities": [
    "artifact.upload",
    "directory.read",
    "directory.write",
    "event.stream",
    "process.verify",
    "resume"
  ]
}
```

The local machine enrolls once and receives an expiring runner identity:

```bash
npm run archie:runner -- \
  --url https://archie.example/ \
  --root /private/archie-runner \
  --enrollment-token <single-use-token>
```

Subsequent runs reuse the local identity stored with private filesystem permissions under:

```text
/private/archie-runner/.archie-runner/state.json
```

The runner never opens a listener. It polls the hosted service through outbound HTTP or HTTPS requests.

## Work offers

A founder may offer an existing open Archie task:

```http
POST /v1/hybrid/founder/offers
Content-Type: application/json
X-Archie-CSRF: <session csrf>

{
  "workspace_id": "workspace_example",
  "task_id": "task_example",
  "title": "Materialize one bounded result",
  "required_protocol_version": "1.0.0",
  "required_capabilities": [
    "artifact.upload",
    "directory.read",
    "directory.write",
    "event.stream",
    "process.verify",
    "resume"
  ],
  "minimum_resources": {
    "memory_bytes": 1,
    "disk_free_bytes": 1
  },
  "allowed_paths": ["output/**"],
  "execution": {
    "schema": "archie-hybrid-materialize-files/v1",
    "request": "Materialize the admitted result and verify its exact digest.",
    "files": [
      {
        "path": "output/result.json",
        "content_base64": "eyJvayI6dHJ1ZX0K",
        "sha256": "<sha256-of-decoded-bytes>"
      }
    ]
  },
  "artifact_admission": [
    {
      "artifact_id": "artifact_result",
      "path": "output/result.json",
      "name": "result.json",
      "media_type": "application/json",
      "required": true,
      "max_bytes": 100000,
      "sha256": "<sha256-of-decoded-bytes>"
    }
  ],
  "lease_ttl_ms": 120000
}
```

The first mergeable protocol deliberately supports one deterministic execution contract: `archie-hybrid-materialize-files/v1`. New execution adapters must preserve the same capability, fencing, event, artifact, and terminal-receipt laws rather than weakening them.

## Authority boundary

A hybrid offer cannot grant:

- contact or communication authority;
- spending or purchasing authority;
- deployment or publishing authority;
- arbitrary network-task authority;
- credential or secret transfer;
- an unbounded shell;
- writes outside the exact leased paths.

The runner advertises exact platform, architecture, CPU count, memory, free disk, capabilities, version, and privacy boundary. Hosted Archie claims a task only when the advertisement satisfies the offer.

Each claim creates:

- one workspace-scoped runner principal;
- one task-scoped Archie grant;
- one Archie-native lease;
- one random fence token stored only as a digest by the hosted service;
- one canonical Archie run.

A wrong or stale fence cannot append events, upload artifacts, or terminate the run.

## Local execution

Effects are confined to:

```text
<root>/workspace
```

Maker receives exact owned paths and an allowlisted verification command. Runner identity, fence state, manifests, and Maker control state remain under the separate private control directory:

```text
<root>/.archie-runner
```

The first protocol admits UTF-8 files only. Assigned bytes are verified before writing, and the completed files are verified again by digest and size before upload.

## Events, artifacts, and interruption

Runner progress events are bound by:

- lease ID;
- strictly increasing sequence;
- previous-event digest;
- payload digest;
- complete event digest.

Only artifacts explicitly listed in `artifact_admission` may be uploaded. Required artifacts must exist before completion. Raw local paths, runner tokens, enrollment tokens, and fence tokens never enter workspace events or receipts.

The local state preserves the current lease, fence, sequence, and event head. Restarting the runner resumes the same active lease while it remains valid.

A successful run records an `archie-hybrid-terminal-receipt/v1` artifact. A local execution failure records an `archie-hybrid-failure-receipt/v1` artifact and leaves the Archie task blocked rather than simulating completion.

## Inspection

The founder can inspect protocol state at:

```http
GET /v1/hybrid/founder/status
```

The response reports runner, pending-offer, active-lease, completed-lease, and failed-lease counts plus the fixed deny-by-default authority boundary.

## Truth boundary

A passing hybrid-runner test proves outbound enrollment, exact resource and privacy advertisement, fenced task claims, digest-bound event streaming, explicit artifact admission, interruption recovery, terminal success and failure receipts, and Archie-native workspace integration.

It does not prove external deployment, unrestricted remote control, trained-model quality, physical-device performance, or customer-value superiority. GitHub remains unnecessary to the protocol and is not its identity, queue, event stream, artifact store, or review authority.
