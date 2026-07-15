# Maker activation revival

- Parent: #223
- Lane: #229
- Draft PR: #239
- Adopted implementation: PR #222 exact head `96235b22810cb59648ce945e084599ab4a71a69d`
- Base: `main@ffcdda7bdcb6d2b7411b6c4965adf8837cb5a86a`
- State: implementation adopted; runtime execution still unproven

## Executable state

The branch now contains the provider-neutral issue worker, direct OpenAI-compatible and Ollama-compatible adapters, recursive planning pass, bounded repository tool loop, workflow authority preflight, independent repository verification, episode artifacts, and local/hosted setup documentation.

## Remaining activation boundary

One real model endpoint must be selected and configured. Then one owner-authored Maker issue must produce a non-secret endpoint receipt, planning episode, bounded edit/test transcript, pushed branch, and draft pull request.

No model endpoint, API key, model download, self-hosted runner, merge, or deployment is inferred by adopting the code.
