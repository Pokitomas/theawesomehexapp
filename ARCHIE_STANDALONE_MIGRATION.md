# Archie standalone migration

## Decision

Archie is migrating from source-host-shaped coordination into one provider-neutral local service and product. GitHub remains a temporary code transport and an optional future import/export adapter. It is not the canonical workspace, queue, event stream, review system, artifact store, identity system, or runtime authority.

The first process boundary is `archied`.

```bash
npm run archie:dev
npm run archie:local
```

Both commands use durable state outside the repository by default:

```text
ARCHIE_HOME/standalone/workspaces
```

Local operation requires no GitHub account, token, remote, DNS access, or network after installation.

## Existing contract inventory

| Concern | Existing authority retained in tranche 1 | Migration decision |
| --- | --- | --- |
| Workspace/objective/task graph | `scripts/archie-workspace-core.mjs` | Retain and expose through `archied`; do not create parallel domain types. |
| Principals, grants, and leases | `scripts/archie-workspace-core.mjs` | Retain fail-closed capability checks and single-writer leases. |
| Append-only history | digest-chained workspace events | Retain as canonical history. Every mutation remains independently replayable and verifiable. |
| Durable local storage | `SafeFileWorkspaceProvider` | Retain for the first executable slice because it already supplies writer locking, event-chain verification, restart durability, and content-addressed artifact storage. SQLite may later serve as an index or alternate adapter; it must not replace digest authority without stronger evidence. |
| Artifacts | SHA-256 content-addressed files with `archie-artifact://` projection | Retain. Raw bytes stay outside event payloads and local filesystem paths never enter public state. |
| Evidence/review/promotion/rollback | workspace commands and receipts | Retain and move behind one product surface. |
| Maker execution | `MakerEngine` and existing Maker receipts | Wrap through workspace leases in the next tranche. Archie plans; Maker remains the only admitted effect writer. |
| Trained model/runtime | existing Archie runtime and empirical admission contracts | Keep separate. A functioning standalone product does not imply an admitted trained candidate or physical-device capability. |
| GitHub issues, PRs, Actions, Pages | temporary engineering transport | Never import as canonical runtime state. Add explicit adapters only after local-directory, Git, and portable-bundle paths work. |

## Migration sequence

1. Establish `archied`, its durable root, exact health/version/migration descriptor, and restart proof.
2. Add the unified responsive client without browser-only canonical state.
3. Route a real bounded directory task through Maker and retain its event stream, artifact, terminal receipt, requested change, rerun, approval, and rollback.
4. Export and restore an integrity-checked portable workspace under a GitHub blackout.
5. Run identical contracts in a containerized hosted mode with private founder access.
6. Add an outbound, expiring, fenced hybrid runner.
7. Import existing local/Git/GitHub-linked material through compatibility adapters, then delete source-host-canonical assumptions only after executable equivalence and rollback tests.
8. Run the real LBTB purchase-order program as the first outcome-compounding consumer benchmark.

## Hard truth boundary

`archied` may truthfully claim durable local workspaces, explicit authority, append-only history, content-addressed artifacts, evidence, review, approval, rollback, and source-host independence only when the corresponding receipts exist.

It may not infer or market:

- a trained or admitted Archie candidate;
- native MLX/GGUF execution;
- physical A15 performance;
- hosted deployment;
- customer-value superiority;
- autonomous spending, contact, deployment, or destructive authority.

Those claims remain fail-closed behind their independent programs and evidence.
