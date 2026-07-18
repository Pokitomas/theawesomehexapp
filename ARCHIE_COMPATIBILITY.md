# Archie compatibility migration

Archie can migrate an existing local directory or Git working tree into provider-neutral Archie state without making GitHub, a Git remote, or the original filesystem path part of the runtime authority.

## Import

```bash
npm run archie:migrate:local -- --source /path/to/existing-program --label "Existing program"
```

PowerShell:

```powershell
npm run archie:migrate:local -- --source C:\path\to\existing-program --label "Existing program"
```

The command runs locally and requires no network, GitHub account, token, remote, DNS access, or source-host API.

It creates:

- a bounded, digest-verified source archive;
- one Archie-native workspace with objective, task graph, grants, run history, artifacts, review, and evidence;
- an explicit compatibility decision recording that source-host state is not canonical;
- a portable `.archie.json` workspace export under `ARCHIE_HOME/standalone/exports`.

The CLI response intentionally omits local output paths. Workspace events and portable artifacts do not contain the absolute source path.

## Admission boundary

The default scan admits at most:

- 300 files;
- 512 KiB per file;
- 8 MiB total admitted content.

Files are sorted deterministically before admission. Each admitted file carries its relative path, byte size, SHA-256 digest, and exact bytes. The archive itself has a stable digest over its bounded identity.

The adapter skips:

- symlinks and non-regular files;
- secret-like names such as `.env`, credentials, tokens, cookies, private keys, and certificate containers;
- generated or dependency trees such as `node_modules`, build output, caches, and coverage;
- Git object storage, logs, hooks, indexes, and transient Git state;
- files beyond the configured file, per-file, or aggregate byte limits.

Every skipped entry is recorded with a reason. The adapter does not silently reinterpret an excluded file as safe.

## Git projection

When `.git` exists, Archie may preserve limited provenance:

- current ref name;
- resolved head commit when available;
- remote name;
- provider class such as GitHub, GitLab, Bitbucket, or other;
- a SHA-256 digest of the remote endpoint.

Raw remote URLs, embedded usernames, tokens, credentials, and repository-host identity are not preserved. Git objects are not copied. Git metadata is an optional provenance and future import/export adapter only; it is not Archie’s workspace, event stream, review system, artifact store, identity authority, queue, or runtime database.

## Restore and replay

The source archive can restore the admitted files into an empty target directory. Restore verifies the archive and every file digest before writing and prevents paths from escaping the selected root.

The exported Archie workspace can be imported into a second provider root. Import verifies:

- the complete digest-chained event stream;
- event count and terminal head;
- every artifact digest and byte size;
- workspace identity before mutation.

A successful clean-root replay proves migration integrity and portability. It does not prove that omitted secrets or generated dependencies can be recreated automatically.

## Truth boundary

Compatibility success means that bounded existing material, migration decisions, exclusions, provenance, evidence, and artifacts survive as Archie-owned portable state. It does not prove product improvement, customer value, behavioral equivalence for excluded dependencies, deployment readiness, trained-model quality, or native-device capability.
