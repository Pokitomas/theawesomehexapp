# Archie real-device evidence campaigns

`archie:device:evidence` executes platform adapters and turns only validated observations into launch-capability entries. It does not accept a prewritten capability manifest as proof.

## Command

```text
npm run archie:device:evidence -- \
  --campaign device-campaign.json \
  --output device-evidence-package.json
```

The command exits nonzero when any probe marked `required_for_launch` fails.

## Execution law

Each probe declares:

- an exact executable with byte count and SHA-256 digest
- every adapter or support file whose bytes participate in the probe
- an argument vector, working directory, timeout, and explicitly permitted environment-variable names
- the capability families and faculties being tested
- ordered real-device events that must be observed
- required permissions and permissions whose revocation must deny subsequent access
- metric gates, minimum resources, dependencies, conflicts, and network requirements

The harness verifies command bytes before execution, launches without a shell, strips the environment to an allowlist, supplies a fresh random nonce over standard input, limits output, enforces a timeout, and hashes standard output and standard error. A stale or precomputed receipt cannot satisfy the fresh nonce.

## Adapter result

An adapter returns one JSON object using `archie-real-device-probe-result/v1`. The result must bind:

- campaign ID and canonical campaign digest
- probe ID
- exact device fingerprint
- the fresh nonce
- real-device execution (`real_device: true`, `mock: false`)
- ordered event receipts with evidence digests
- permission receipts
- revocation receipts showing subsequent access was denied
- bounded metrics and resource cost
- at least one exact evidence artifact stored under the campaign root
- a canonical `result_digest`

Malformed output, command mutation, artifact mutation, missing events, permission gaps, revocation gaps, metric failures, impossible rates, timeouts, nonzero exits, output overflow, mock output, and nonce mismatch fail closed.

## Output and launch integration

The package emits capability objects matching the fields consumed by `archie:launch:resolve`: status, families, faculties, evidence digests, dependencies, conflicts, required permissions, network mode, metrics, gates, minimum resources, and resource cost.

A failed required probe emits an `absent` capability with explicit blockers. It cannot contribute faculties to the maximal launch profile. A successful device-evidence package still does not admit intelligence, aggregate launch resources, or a product form by itself; it must be joined with the admitted student, launch decision, exact machine manifest, and profile/frontier resolver.

## Platform adapters

Platform-specific adapters remain responsible for causing and observing the actual OS events. Examples include microphone capture and speaker interruption, screen-consent capture and multimodal ingestion, background execution and notification delivery, process suspension and state restoration, and capability revocation. The neutral harness makes those adapters replaceable while preventing any adapter name or provider reputation from substituting for exact execution receipts.
