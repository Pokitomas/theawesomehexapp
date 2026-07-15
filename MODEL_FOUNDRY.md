# Native Model Foundry

This subsystem turns general-purpose local agents into a controlled scientific search process for native model architectures and learning mechanisms.

It deliberately does **not** contain a preferred architecture. The runtime creates ten independent read-only research assignments, preserves contradictions, constructs a diversified experiment portfolio, and refuses promotion without matched-resource evidence. Generation zero adds a bounded executable layer that tests candidate-specific mechanisms without claiming final-scale training or intelligence.

## What exists

- `foundry/directive.md` — complete parallel research directive.
- `foundry/core.mjs` — public protocol exports.
- `foundry/util.mjs` — deterministic serialization, hashing, normalization, and secret-field rejection.
- `foundry/protocol.mjs` — missions, ten role packets, report validation, contradiction graphs, and integration.
- `foundry/experiments.mjs` — experiment portfolios, genomes, Pareto selection, admission, and receipts.
- `foundry/runtime.mjs` — concurrent local-agent execution with a clean-worktree guard.
- `foundry/run.mjs` — command-line entrypoint for the full read-only sprawl.
- `foundry/cli.mjs` — deterministic protocol utilities.
- `foundry/generation-zero-data.mjs` — architecture-neutral mission, reports, candidate genomes, and lawful corpus plan.
- `foundry/generation-zero-proxy.mjs` — executable symbolic, dynamics, adaptation, and delayed-memory falsification probes.
- `foundry/generation-zero.mjs` — generation-zero orchestration, receipts, artifact manifest, and bundle verification.
- `foundry/GENERATION_ZERO.md` — exact execution and evidence boundary.
- `foundry/example-mission.json` — architecture-agnostic mission.
- `foundry/example-genome.json` — complete serialization shape, explicitly not a proposed winner.
- `foundry/tests/` — hostile core, runtime, proxy, and artifact-integrity witnesses.

## Run the parallel foundry

The agent command is passed as a JSON argv array. No shell is used. Each process receives one assignment packet on standard input and must return one report object as JSON on standard output.

```bash
node foundry/run.mjs \
  --mission foundry/example-mission.json \
  --agent-argv '["codex","exec","--sandbox","read-only","-"]' \
  --out /tmp/sideways-foundry-run
```

An alternative local agent can be supplied without changing the foundry:

```bash
SIDEWAYS_FOUNDRY_AGENT_ARGV='["my-agent","--json","--read-only"]' \
  node foundry/run.mjs \
  --mission foundry/example-mission.json \
  --out /tmp/sideways-foundry-run
```

The working tree must be clean before execution. The runtime compares Git status before and after all ten agents and fails closed when any assessment agent mutates the repository.

## Run generation zero

Generation zero uses the integrated ten-role reports and executes tiny deterministic candidate-specific mechanisms on separated train, holdout, and procedural out-of-distribution probes.

```bash
npm run foundry:generation-zero -- \
  --out /tmp/sideways-generation-zero \
  --code-revision "$(git rev-parse HEAD)"
```

The command writes the artifact files through temporary paths and writes `artifact-manifest.json` last. The manifest records the exact code revision, byte length, and SHA-256 digest of every canonical JSON artifact. Absence of the manifest means the bundle is incomplete. A digest or byte mismatch means the evidence must not be consumed.

Programmatic verification is available through `verifyGenerationZeroArtifactBundle` from `foundry/generation-zero.mjs`.

## Generated artifacts

A successful read-only parallel run writes:

- `mission.json`
- `assignments.json`
- `reports.json`
- `integration.json`
- `portfolio.json`
- `receipt.json`

A successful generation-zero run writes those scientific-control artifacts plus:

- `genomes.json`
- `proxy-results.json`
- `negative-results.json`
- `corpus-plan.json`
- `artifact-manifest.json`

`receipt.json` carries two distinct identities:

- `receipt_digest` covers the base Foundry protocol receipt;
- `generation_receipt_digest` covers the complete generation-zero receipt, including exact revision, proxy outcomes, and truth-boundary fields.

The CLI's top-level `receipt_digest` is the full `generation_receipt_digest`. `protocol_receipt_digest` remains available for consumers that need the base protocol identity.

The portfolio contains bounded experiments. Generation zero may execute tiny proxies, but it does not grant dependency installation, corpus acquisition, training spend, merge, deployment, model export, or promotion authority.

## Protocol-only commands

```bash
node foundry/cli.mjs validate-mission foundry/example-mission.json
node foundry/cli.mjs assignments foundry/example-mission.json
node foundry/cli.mjs validate-genome foundry/example-genome.json
```

Reports from another runtime can be integrated directly:

```bash
node foundry/cli.mjs integrate foundry/example-mission.json /path/to/reports.json
node foundry/cli.mjs portfolio /path/to/integration.json 12
```

## Evidence boundary

The foundry distinguishes four things:

1. **hypothesis** — a proposed mechanism;
2. **experiment lease** — permission to implement a bounded test, not proof;
3. **generation-zero proxy result** — candidate-specific code executed on tiny controlled probes, still not a final architecture or scale claim;
4. **admitted result** — a reproduced matched-compute gain that passed hidden evaluation, broad regression, sabotage review, and resource accounting.

Candidate identity never determines a proxy score. Shared thresholds apply across candidates; unknown proxy suites fail closed. Renaming a candidate without changing its mechanism leaves its metrics unchanged.

Orchestration is infrastructure. It becomes a native-model result only after an exported candidate genome and measured artifact satisfy the admission gate.

## Relationship to Maker

Maker supplies general repository assessment, one-writer implementation, GitHub collision control, and exact-head verification. The foundry supplies the scientific objective, machine-readable research protocol, candidate genomes, and evidence admission boundary.

The lanes remain intentionally separate:

- Maker decides **how repository work is safely executed**.
- The foundry decides **which model experiment is informative enough to deserve execution**.

Maker may consume Foundry assignments or selected portfolio entries under fresh non-overlapping leases. A generation-zero survivor is not automatically a Maker implementation command and is never automatically promoted.

## Focused verification

```bash
node --check foundry/core.mjs
node --check foundry/util.mjs
node --check foundry/protocol.mjs
node --check foundry/experiments.mjs
node --check foundry/runtime.mjs
node --check foundry/run.mjs
node --check foundry/cli.mjs
node --check foundry/generation-zero-data.mjs
node --check foundry/generation-zero-proxy.mjs
node --check foundry/generation-zero.mjs
npm run test:foundry
```
