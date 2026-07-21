# Archie Continuum

Archie Continuum turns GitHub into a **signed control plane** while the Alienware remains the compute plane. It is intentionally not a generic self-hosted Actions runner.

GitHub emits a small HMAC-signed capsule naming an exact commit and a locally allowlisted task. The Alienware daemon pulls the capsule over outbound HTTPS, verifies its signature and expiry, creates an isolated worktree at the exact SHA, downloads and hashes any required canonical artifact, checks CUDA, executes a fixed local argv template, preserves checkpoints and logs on local disk, and publishes a sealed research-only result bundle to a draft GitHub release.

Remote JSON never contains a shell command. A capsule can select only task names and arguments already permitted in the Alienware's local `config.json`.

## Novel protocol: `SUCCESS`

`SUCCESS` is a provider-neutral, digest-locked handoff barrier:

1. Freeze independent generation for every required registered adapter.
2. Canonicalize the completed state and compute one SHA-256 digest.
3. Broadcast the same envelope concurrently to command adapters or file inboxes.
4. Require each provider to acknowledge that exact digest.
5. Preserve observations and proposed next capsules, but never execute them until GitHub emits a new signed capsule.

That means Codex, Claude, OpenAI API agents, Ollama models, scripts, or future providers can all join through the same adapter contract. It does not pretend to reach providers that have not been registered locally.

During training, immutable rung files may also be broadcast as `STUDY` envelopes. Agents can analyze progress while the GPU continues running, but their suggestions cannot alter the active objective, evaluator, allocation, or promotion boundary.

## Security properties

- Repository-owner manual dispatch signs the capsule.
- The capsule source SHA is the workflow's exact checked-out `GITHUB_SHA`.
- HMAC secret must match locally and in GitHub secret `ARCHIE_CONTINUUM_HMAC_KEY`.
- The local configuration independently allowlists repositories, tasks, arguments, node identity, and CUDA requirements.
- Rendezvous hashing deterministically divides shards across several Alienwares without a central scheduler.
- Dirty or mismatched worktrees fail closed.
- Canonical source artifacts are downloaded by exact run and name, then inventoried by SHA-256.
- Results always remain `research-only-not-admitted`.
- GitHub release publication is explicit and uses the local authenticated `gh` session; tokens are never stored in capsules.

## Install in WSL2

Prerequisites:

- Current NVIDIA Windows driver with WSL CUDA support
- CUDA-enabled PyTorch in WSL
- `git` and authenticated GitHub CLI (`gh auth login`)
- Python 3.11+

```bash
./compute/continuum/install.sh
export ARCHIE_CONTINUUM_HMAC_KEY='use-a-random-secret-of-at-least-32-characters'
python3 compute/continuum/continuum.py doctor \
  --config ~/archie-continuum/config.json
```

Set the identical value as the repository Actions secret `ARCHIE_CONTINUUM_HMAC_KEY`. Edit `node_id`, `poll.branch`, local task policy, and providers in the generated configuration.

Start the backend:

```bash
python3 compute/continuum/continuum.py serve \
  --config ~/archie-continuum/config.json
```

The daemon stores durable state in SQLite under the configured workspace, so restarting WSL does not replay completed capsule runs.

## Dispatch a GPU job

From GitHub, manually run **Archie Continuum capsule** on the exact branch or commit you want trained. The workflow signs only its own checked-out SHA and uploads `capsule.json`. The local daemon discovers the successful control run, verifies it, and executes the corresponding local task.

The included terminal task preserves the existing trainer and frozen evaluator. `terminal_cuda.py` changes only tensor placement: generated batches, models, and frozen batches move to the selected CUDA device. Architecture, objective, data, successive-halving policy, and report logic remain in `efficient_terminal_training.py`.

## Add providers to `SUCCESS`

A command adapter receives the envelope JSON on stdin. Its final stdout line must be JSON:

```json
{
  "handoff_digest": "the envelope state_digest",
  "observations": ["what this provider learned"],
  "proposed_next_capsule": null
}
```

Example local configuration:

```json
{
  "id": "ollama-qwen",
  "mode": "command",
  "argv": ["python3", "/home/kai/provider-adapters/ollama_adapter.py"],
  "required": false,
  "timeout_seconds": 300
}
```

File adapters receive `<barrier>.json` in their inbox and must create `<barrier>.ack.json`. This supports long-running agents and providers that cannot be spawned as a subprocess.

Manual universal handoff:

```bash
python3 compute/continuum/continuum.py SUCCESS \
  --config ~/archie-continuum/config.json \
  --state state.json \
  --source-sha <exact-40-character-sha>
```

## Multi-PC behavior

Put all node IDs in the signed capsule, for example `["alienware-1","alienware-2"]`, and use more than one shard. Every node computes the same rendezvous assignment from `job_id + shard + node_id`; each shard has exactly one winner. Tasks that support explicit shard arguments can consume `{shard_indices}` and `{shard_count}` from their local argv templates.

This is usually better than pretending separate GPUs form one VRAM pool. Independent arms, seeds, data shards, evaluations, and ablations distribute cleanly; model-parallel training still requires an explicitly distributed trainer.
