# Foundry ↔ Maker Lasso Adapter

This adapter turns the canonical native Foundry’s selected experiment portfolio into bounded Maker work packets. It does not replace `foundry/**`, invent a second role registry, execute agents, train models, open branches, write receipts into the checkout, or grant merge/deploy authority.

## Exact inputs

Every lasso invocation requires four explicit artifacts:

1. `portfolio.json` emitted by `node foundry/cli.mjs portfolio ...`;
2. a `sideways-foundry-genome-manifest/v1` proving each selected candidate has a validated genome and receipt bound to the exact base SHA;
3. a `sideways-open-path-leases/v1` snapshot of every currently open writer lease, including an explicit empty array when none exist;
4. the exact 40-character base SHA.

The adapter consumes the Foundry’s assignment artifact for role routing. Canonical role IDs therefore come from `assignments.json`; they are not copied into this adapter.

## Read-only commands

```bash
node scripts/foundry-agent-cli.mjs lasso \
  --portfolio /tmp/foundry-run/portfolio.json \
  --genomes /tmp/foundry-run/genome-manifest.json \
  --peer-leases /tmp/open-leases.json \
  --base-sha "$BASE_SHA" \
  --budget 4

node scripts/foundry-agent-cli.mjs status \
  --portfolio /tmp/foundry-run/portfolio.json \
  --genomes /tmp/foundry-run/genome-manifest.json \
  --peer-leases /tmp/open-leases.json \
  --base-sha "$BASE_SHA"

node scripts/foundry-agent-cli.mjs assignment \
  --assignments /tmp/foundry-run/assignments.json \
  --role benchmark-saboteur
```

All commands emit JSON to standard output only. They do not accept an output-file flag.

## Genome manifest

```json
{
  "schema": "sideways-foundry-genome-manifest/v1",
  "base_sha": "<40 hex>",
  "genomes": {
    "candidate-id": {
      "path": "foundry/genomes/candidate-id.json",
      "genome_digest": "<64 hex>",
      "validation_receipt_digest": "<64 hex>",
      "validation_command": "node foundry/cli.mjs validate-genome foundry/genomes/candidate-id.json",
      "code_revision": "<same 40 hex>",
      "seeds": [7, 11],
      "validated": true
    }
  }
}
```

The adapter does not reimplement genome validation. It requires a deterministic validation manifest produced after the canonical Foundry validator succeeds.

## Open peer lease snapshot

```json
{
  "schema": "sideways-open-path-leases/v1",
  "base_sha": "<40 hex>",
  "open_leases": [
    {
      "pr_number": 123,
      "state": "open",
      "base_sha": "<40 hex>",
      "head_sha": "<40 hex>",
      "branch": "maker/example",
      "owned_paths": ["src/example/**"]
    }
  ]
}
```

Historical lease files in `maker/leases/` are not treated as live ownership. Current open-PR truth must be supplied explicitly, so closed or merged work cannot permanently block new experiments.

## Fail-closed gates

No packet is emitted when any selected candidate lacks a validated genome, the base identities disagree, a secret-like field appears, spend is non-finite, a falsifier/hidden evaluation/matched baseline is absent, reproduction requires fewer than two seeds, a path is absolute/traversing/ambiguous, two packets overlap, an open peer lease overlaps, or accepted cost exceeds remaining portfolio budget.

Every accepted packet binds:

- exact base SHA;
- deterministic `maker/foundry-*` branch name;
- exclusive implementation/test paths;
- focused test command and required evidence artifacts;
- validated genome and receipt digests;
- matched-compute, falsifier, hidden-evaluation, and reproduction contracts;
- bounded proxy compute and wall time;
- rollback instructions;
- human-only merge/deploy authority and no install/training authority.

## Verification

```bash
node --check scripts/foundry-agent-spawner.mjs
node --check scripts/foundry-agent-cli.mjs
node --test scripts/tests/foundry-agent-spawner.test.mjs
```

The focused suite includes hostile path, secret, stale-base, missing-genome, budget, peer-collision, deterministic-receipt, canonical-assignment, and stdout-only CLI witnesses.
