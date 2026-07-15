# Native Maker runtime

## What the issue trigger does

`[maker:*]` issue creation can start three independent paths:

1. the lasso records the GitHub arrival in the weave when Remote credentials exist;
2. coordination workflows update repository state;
3. the native Maker workflow may run an actual engineering model.

The lasso is not the engineering model. A lasso success does not mean a model inspected files, edited code, ran tests, created a branch, or opened a pull request.

The native path is:

`owner Maker issue -> read-only authority preflight -> model planning roles -> bounded repository tool loop -> independent repository verification -> pushed branch -> draft pull request`

Merge and deployment remain human actions.

## Hosted open-model-compatible endpoint

Set repository variables:

- `SIDEWAYS_MODEL_MODE=hosted`
- `SIDEWAYS_MODEL_PROTOCOL=openai` or `ollama`
- `SIDEWAYS_MODEL_BASE_URL=<endpoint base URL>`
- `SIDEWAYS_MODEL_NAME=<model identifier>`

Set repository secret only when the endpoint requires bearer authentication:

- `SIDEWAYS_MODEL_API_KEY=<manual provider key>`

The implementation uses HTTP request shapes directly. It does not install or import a proprietary provider SDK.

Optional limits:

- `SIDEWAYS_MODEL_TIMEOUT_MS`
- `SIDEWAYS_PLANNING_ENABLED`
- `SIDEWAYS_PLANNING_MAX_WAVES`
- `SIDEWAYS_PLANNING_MAX_EVENTS`
- `SIDEWAYS_PLANNING_MAX_ASSIGNMENTS`
- `SIDEWAYS_AGENT_MAX_TURNS`
- `SIDEWAYS_AGENT_MAX_WRITES`
- `SIDEWAYS_AGENT_MAX_WRITE_BYTES`
- `SIDEWAYS_AGENT_MAX_MODEL_TOKENS`

## Fully local model path

The local model does not run on the phone. The phone creates the Maker issue. A computer you control runs the model and GitHub runner.

Required manual actions:

1. Install an open-model server on the computer.
2. Download or mount the chosen model weights using that server's normal method.
3. Start an Ollama-compatible endpoint, or another endpoint with an OpenAI-compatible chat-completions route.
4. Probe it from the repository checkout:

```bash
node scripts/check-open-model-runtime.mjs \
  --protocol ollama \
  --base-url http://127.0.0.1:11434 \
  --model YOUR_MODEL_NAME
```

5. In GitHub repository settings, create a self-hosted Actions runner for this repository.
6. GitHub will display a temporary runner registration token and exact setup commands. Enter those manually on the computer. Never post that token in an issue, commit, screenshot, or chat transcript.
7. Add the custom runner label `sideways-maker`.
8. Set repository variables:

- `SIDEWAYS_MODEL_MODE=self-hosted`
- `SIDEWAYS_MODEL_PROTOCOL=ollama`
- `SIDEWAYS_MODEL_NAME=YOUR_MODEL_NAME`
- optionally `SIDEWAYS_MODEL_BASE_URL` when the server is not at `http://127.0.0.1:11434`

Public model downloads commonly need no API key. Private model registries or hosted endpoints may require authentication supplied manually to that registry or as `SIDEWAYS_MODEL_API_KEY`. No authentication value belongs in repository text.

## Execution authority

The model receives these tools only:

- list tracked repository files;
- read bounded UTF-8 ranges;
- search tracked text;
- write bounded files inside the checkout;
- run fixed allowlisted witnesses;
- inspect git status and diff;
- finish with a typed receipt.

The tool runtime blocks path traversal, secret-like files, `.git`, dependency caches, workflow files, Actions definitions, authority manifests, arbitrary shell commands, package installers, network tools, destructive git operations, merge, and deployment.

The outer trusted worker independently runs:

- `git diff --check`
- changed-file syntax and JSON checks
- `npm run verify:repository`

Only a passing patch is committed, pushed, and opened as a draft pull request.

## Planning sprawl

Before editing, the configured model is reused through typed proposer, opponent, verifier, implementer, integrator, historian, and critic adapters. Their outputs enter the existing recursive weave event model and are reduced into a bounded planning brief. Planning failure is recorded and the direct implementation path may still proceed.

This is model-assisted planning, not a new trained model.

## Episode dataset

Every configured run writes a non-secret structured Actions artifact named `sideways-native-maker-episode-*` containing:

- Maker intent;
- provider protocol, model name, and endpoint host;
- typed planning results;
- bounded tool actions and observations;
- verification witnesses;
- final outcome and draft pull-request URL when produced.

This creates raw material for later evaluation or distillation. No fine-tuning, weight update, model download, or architecture search currently happens automatically. Those require a separately admitted training pipeline, compute, model weights, dataset policy, and any necessary manual credentials.

## Missing configuration behavior

When no model mode is configured, the workflow posts a blocked receipt on the Maker issue. It explicitly states that no engineering model, workspace, branch, patch, or pull request ran. This prevents a successful lasso receipt from being mistaken for autonomous development.
