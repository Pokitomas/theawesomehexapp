# Archie enrolled outbound hybrid runner

This protocol lets a private local machine execute one narrowly admitted filesystem task for hosted Archie without opening an inbound port or exposing the machine, its credentials, or its model state.

Hosted Archie remains authoritative for objectives, tasks, principals, grants, leases, event chains, admitted artifacts, terminal receipts, evidence, review, approval, and rollback. The local process is a bounded Maker executor.

This is complementary to the portable-workspace queue runner. The existing queue path leases a complete standalone Archie journey and returns a verified workspace bundle. The enrolled path below attaches a short-lived runner directly to an existing native workspace task and streams exact events and artifacts into that workspace.

## Operating sequence

A founder creates a short-lived, single-use enrollment token through the private hosted service:

```http
POST /v1/hybrid/founder/enrollments
Authorization: Bearer <founder-token>
Content-Type: application/json

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

The local machine enrolls once:

```bash
npm run archie:runner:enrolled -- \
  --url https://archie.example/ \
  --root /private/archie-runner \
  --enrollment-token <single-use-token>
```

Subsequent cycles reuse the local identity stored with private filesystem permissions under:

```text
/private/archie-runner/.archie-runner/state.json
```

The runner never opens a listener. It contacts hosted Archie only through outbound HTTP or HTTPS requests.

## Exact advertisement

Enrollment reports the exact protocol and runner version, platform, architecture, CPU count, memory, free disk, capabilities, bounded root, artifact policy, and privacy boundary. The advertisement explicitly denies inbound access, contact, spending, deployment, publishing, arbitrary networking, and credential transfer.

Hosted Archie stores only the runner-token digest. Enrollment tokens are single-use and expire. Runner identities also expire and cannot silently widen their advertisement after enrollment.

## Work offers

A founder can offer an existing open Archie task:

```http
POST /v1/hybrid/founder/offers
Authorization: Bearer <founder-token>
Content-Type: application/json

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

The first protocol deliberately admits one deterministic execution contract: `archie-hybrid-materialize-files/v1`. New execution adapters must preserve the same capability, fencing, event, artifact, and terminal-receipt laws.

## Authority boundary

An offer cannot grant:

- contact or communication authority;
- spending or purchasing authority;
- deployment or publishing authority;
- arbitrary network-task authority;
- credential or secret transfer;
- an unbounded shell;
- writes outside the exact leased paths.

Hosted Archie claims a task only when the runner advertisement satisfies the offer. Each claim creates one workspace-scoped runner principal, one task-scoped native grant, one native lease, one random fence token stored only as a digest by the hosted service, and one canonical Archie run.

A wrong, stale, or expired fence cannot append events, upload artifacts, complete, or fail the run.

## Local execution

Effects are confined to the explicit `--root`. The first adapter therefore writes `output/**` beneath that root while runner identity, fence state, sequence, event head, and Maker control state remain under:

```text
<root>/.archie-runner
```

Maker receives exact owned paths and an allowlisted verification command. Assigned bytes are verified before writing and completed files are verified again by digest and size before upload.

## Events, artifacts, and interruption

Progress events bind the lease ID, strictly increasing sequence, previous-event digest, payload digest, and complete event digest. Only artifacts explicitly listed in `artifact_admission` may upload, and all required artifacts must exist before completion.

The local state preserves the active lease, fence, sequence, and event head. Restarting the runner resumes the same lease while it remains valid. An expired or reassigned lease fails closed.

A successful cycle records an `archie-hybrid-terminal-receipt/v1` artifact. A local failure records an `archie-hybrid-failure-receipt/v1` artifact and leaves the native task blocked rather than simulating completion. Raw local paths and enrollment, runner, and fence tokens never enter workspace events or receipts.

## Inspection

The founder can inspect protocol state at:

```http
GET /v1/hybrid/founder/status
Authorization: Bearer <founder-token>
```

Hosted `/v1/hosted/status` also includes the enrolled-runner summary. It reports runner, pending-offer, active-lease, completed-lease, and failed-lease counts plus the fixed deny-by-default authority boundary.

## Truth boundary

A passing enrolled-runner test proves outbound enrollment, exact resource and privacy advertisement, fenced task claims, digest-bound event streaming, explicit artifact admission, interruption recovery, terminal success and failure receipts, and native workspace integration.

It does not prove external deployment, unrestricted remote control, trained-model quality, physical-device performance, or customer-value superiority. GitHub is unnecessary to the protocol and is not its identity, queue, event stream, artifact store, or review authority.
