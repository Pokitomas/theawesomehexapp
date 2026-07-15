# Native Model Foundry

This subsystem turns general-purpose local agents into a controlled scientific search process for native model architectures and learning mechanisms.

It deliberately does **not** contain a preferred architecture. The runtime creates ten independent read-only research assignments, runs them concurrently through an explicit argv command, preserves contradictions, constructs a diversified experiment portfolio, and refuses promotion without matched-resource evidence.

## What exists

- `foundry/directive.md` — complete parallel research directive.
- `foundry/core.mjs` — public protocol exports.
- `foundry/util.mjs` — deterministic serialization, hashing, normalization, and secret-field rejection.
- `foundry/protocol.mjs` — missions, ten role packets, report validation, contradiction graphs, and integration.
- `foundry/experiments.mjs` — experiment portfolios, genomes, Pareto selection, admission, and receipts.
- `foundry/runtime.mjs` — concurrent local-agent execution with a clean-worktree guard.
- `foundry/run.mjs` — command-line entrypoint for the full read-only sprawl.
- `foundry/cli.mjs` — deterministic protocol utilities.
- `foundry/example-mission.json` — architecture-agnostic mission.
- `foundry/example-genome.json` — complete serialization shape, explicitly not a proposed winner.
- `foundry/tests/` — hostile core and runtime witnesses.

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

## Generated artifacts

A successful run writes:

- `mission.json`
- `assignments.json`
- `reports.json`
- `integration.json`
- `portfolio.json`
- `receipt.json`

The portfolio contains leased-but-unexecuted experiments. It does not grant dependency installation, training spend, merge, deployment, or model-export authority.

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

The foundry distinguishes three things:

1. **hypothesis** — a proposed mechanism;
2. **experiment lease** — permission to implement a bounded test, not proof;
3. **admitted result** — a reproduced matched-compute gain that passed hidden evaluation, broad regression, sabotage review, and resource accounting.

Orchestration is infrastructure. It becomes a native-model result only after an exported candidate genome and measured artifact satisfy the admission gate.

## Relationship to Maker

Maker supplies general repository assessment, one-writer implementation, GitHub collision control, and exact-head verification. The foundry supplies the missing scientific objective and machine-readable research protocol.

The two lanes are intentionally separate:

- Maker decides **how repository work is safely executed**.
- The foundry decides **which model experiment is informative enough to deserve execution**.

After both draft lanes integrate, Maker can consume `assignments.json` and implement selected `portfolio.json` experiments under fresh non-overlapping leases.

## Focused verification

```bash
node --check foundry/core.mjs
node --check foundry/util.mjs
node --check foundry/protocol.mjs
node --check foundry/experiments.mjs
node --check foundry/runtime.mjs
node --check foundry/run.mjs
node --check foundry/cli.mjs
node --test foundry/tests/core.test.mjs foundry/tests/runtime.test.mjs
```
