# Squeeze Relay

Squeeze Relay is a local, fail-closed GPU execution relay for sealed research jobs. GitHub remains the control plane and evidence ledger; an Alienware node performs only locally approved, allowlisted work from an exact commit.

## Security boundary

Squeeze Relay is **not** a GitHub Actions self-hosted runner. It never accepts workflow shell, issue-comment commands, pull-request-authored scripts, mutable branch identity, or promotion requests. The relay polls outbound over HTTPS, verifies a sealed capsule, requires local approval for the exact source commit, checks the generated evaluator digest, runs a fixed adapter without `shell=True`, isolates the workspace, and emits a signed evidence receipt.

The initial boundary is deliberately narrow:

- repository: `Pokitomas/theawesomehexapp`
- entrypoint: `foundry/archie-protocol/latent_world_benchmark/research/efficient_terminal_training.py`
- environment profile: `archie-cuda-v1`
- output contract: `terminal-efficiency-v3`
- promotion: `research-only-not-admitted`
- arguments: `--scale base`

A capsule is a request, not authorization. The exact commit must also exist in the local approval ledger. Nonces are single-use and expired jobs are rejected.

## Trust loop

1. GitHub publishes a no-training capsule and `SHA256SUMS`.
2. The relay downloads it using an outbound connection.
3. `squeeze verify` validates schema, repository, commit, digests, arguments, expiration, nonce, and non-admission policy.
4. `squeeze approve <job-id>` records local human approval for that exact capsule digest and commit.
5. `squeeze run <job-id>` checks CUDA, creates a detached clean checkout, materializes the sealed sources, verifies the evaluator, and executes the fixed relay adapter.
6. Checkpoints remain local and resume only when all identity fields match.
7. `squeeze upload <job-id>` returns a signed evidence bundle for independent GitHub-hosted verification.

No inbound port is required. Cross-machine VRAM pooling is explicitly out of scope; separate nodes receive independent arms or seeds.

## Phase boundaries

### Commit 1

Architecture, schemas, capsule parser, local policy verifier, CLI surface, and rejection tests. No training or workflow trigger is introduced.

### Commit 2

CUDA doctor, isolated workspace and executor, resumable checkpoint identity, signed receipts, and the terminal-training GPU adapter. Repository workflows remain deferred until local dry-run evidence exists.

## Local layout

```text
~/.local/share/squeeze/
├── config.toml
├── identity/
├── approvals/
├── jobs/<job-id>/
│   ├── capsule.json
│   ├── source/
│   ├── environment.json
│   ├── checkpoints/
│   ├── logs/
│   ├── heartbeat.json
│   ├── result/
│   └── receipt.json
└── cache/
```

## Development

```bash
cd compute/squeeze
python -m unittest discover -s tests -v
python -m squeeze.cli --help
```

The relay package does not alter PR #697, add a training token, publish a job, or claim admission.
