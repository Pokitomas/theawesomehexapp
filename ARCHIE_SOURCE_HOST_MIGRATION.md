# Archie source-host migration

Archie-native workspaces now own objectives, task graphs, principals, grants, leases, runs, events, artifacts, evidence, reviews, approvals, publication, rollback, portable export, hosted inspection, and outbound local execution.

GitHub remains useful for source transport and collaboration during development. It is not the standalone product database, queue, event stream, runtime identity, review authority, or execution protocol.

## Compatibility import

Import an older local receipt, corpus pack, JSON/JSONL record stream, archive, binary file, or directory:

```bash
node scripts/archie-legacy-import.mjs \
  --input ./legacy-material \
  --root ~/.archie/standalone/workspaces \
  --export ./legacy-material.archie.json
```

The importer:

- derives workspace identity from the complete source content digest;
- preserves every admitted file as exact artifact bytes;
- records media type, size, SHA-256, bounded format classification, and embedded-digest status;
- never executes imported material;
- never stores the local absolute source path;
- treats unknown and invalid formats as opaque exact-byte artifacts;
- records integrity evidence in the Archie-native workspace;
- produces a portable workspace bundle;
- returns the existing workspace unchanged when the exact source is imported again.

An `archie-portable-workspace-bundle/v1` follows the native restore path and preserves its original workspace ID and immutable event head without compatibility reinterpretation.

The first compatibility contract intentionally accepts files and directories rather than silently unpacking arbitrary archives. Archive bytes are preserved exactly as opaque artifacts until a format-specific adapter has executable validation.

## Source-host authority inventory

Generate a repository inventory:

```bash
node scripts/archie-source-host-inventory.mjs \
  --root . \
  --output .archie/source-host-inventory.json
```

The inventory distinguishes:

- canonical runtime blockers;
- runtime migration candidates;
- optional import/export adapters;
- browser-only state requiring migration;
- CI references;
- tests;
- documentation;
- informational references.

Use `--fail-on-blocker` only after the initial inventory has been reconciled. The scanner is conservative: a static match identifies review work, not proof that the path actually executes.

## Deletion law

A GitHub-canonical or browser-canonical runtime path is deleted only when all four receipts exist:

1. **replacement receipt** — an executable Archie-native path owns the same required semantics;
2. **equivalence receipt** — fixtures prove imported state and outcomes survive the replacement;
3. **blackout receipt** — the journey succeeds with GitHub credentials, remote, identity, and network absent;
4. **rollback receipt** — migration can be reversed or the original exact material can be restored.

The current replacement chain is:

- PR #562 — local `archied`, unified client, native workspaces, Maker journey, evidence, approval, rollback, and portable export;
- PR #565 — private hosted inspection over the same Archie domain state;
- PR #568 — outbound fenced local execution without a GitHub runner protocol;
- this compatibility tranche — exact legacy preservation, deterministic import, idempotency, portable restore, and executable source-host inventory.

CI and source collaboration may continue using GitHub. Optional GitHub adapters must translate to and from Archie-native contracts and may not define canonical identity or state.

## Truth boundary

A successful compatibility import proves exact-byte preservation, bounded classification, content-derived identity, restart durability, evidence, idempotency, and portable export. It does not prove semantic equivalence for an opaque format, execute imported code, or authorize deletion of a matched runtime path without its specific replacement and equivalence receipts.
