# Archie live status — phone terminal

This sidecar does not edit the active coordinator. It shows issue #351, the exact coordinator head, drift, the latest coordination heartbeat, any open PR, and a local token ledger in a narrow terminal view.

## Run

```bash
node scripts/archie-live-status.mjs tokens 1310720 1310720
node scripts/archie-live-status.mjs watch 20
```

The read-only dashboard can use GitHub's public API without authentication. For private/rate-limited access, set `GITHUB_TOKEN` or `GH_TOKEN`, or authenticate `gh` once.

Publish or refresh one stable issue heartbeat instead of adding repeated comments:

```bash
node scripts/archie-live-status.mjs heartbeat "repairing the router/runtime composition seam"
```

The heartbeat command requires GitHub authentication. It updates the existing `archie-live-status:v1` marker comment when one exists.

## Token truth

GitHub does not expose the chat/model context counter. The token ledger is therefore explicit and local, not inferred. Update it from an observed counter:

```bash
node scripts/archie-live-status.mjs tokens <remaining> [total]
```

The state is written with mode `0600` under `${XDG_STATE_HOME:-~/.local/state}/archie/live-status.json` unless `ARCHIE_TOKEN_STATE` overrides it. Authentication values are never printed or written to that file.

## Overrides

- `ARCHIE_REPOSITORY`
- `ARCHIE_ISSUE`
- `ARCHIE_BRANCH`
- `ARCHIE_EXPECTED_HEAD`
- `ARCHIE_TOKEN_STATE`

The defaults are pinned to issue #351 and coordinator head `ba9a777504b96a49df29d2dac45988a3acbfb801`. A moved head renders `DRIFT`; it is never silently accepted.
