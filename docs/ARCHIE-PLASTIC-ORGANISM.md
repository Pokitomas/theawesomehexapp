# Archie plastic organism regimen

This is the backend interpretation of Archie as a persistent digital organism,
not a frontend character and not a claim of sentience. The implementation gives
the existing model three distinct learning timescales instead of pretending that
one next-token objective is agency.

## Three learning timescales

1. **Slow weights** are ordinary trained parameters. They change only inside an
   explicit, resumable training run and every export is bound to its corpus,
   configuration, model hash, and receipt.
2. **Fast weights** are a learned recurrent memory matrix carried between local
   interactions. For each token, Archie predicts from the matrix, computes a
   learned value error, and applies a gated causal delta update:

   `M(t+1) = retention(t) * M(t) + write(t) * key(t) outer error(t)`

   This state changes during inference without an optimizer step. It is bounded,
   compact, model-specific, exportable, resettable, and still differentiable
   during training.
3. **Verified experience** is an external ledger of repository observations,
   candidate actions, actual branch outcomes, counterfactual outcomes, mutations,
   hashes, and evaluator receipts. Slow weights absorb it only in a later
   deliberate training run.

A fourth control loop, documented in `docs/ARCHIE-CURRICULUM-EXCHANGE.md`, lets
the current weights barter for supplemental training focus and carries successful
directions between rounds in a pursuit ledger.

That separation is intentional. A conversation may alter fast state immediately,
but it does not silently rewrite the durable model. Durable consolidation remains
replayable and reversible.

## Upgrade the existing checkpoint

The trainer permits exactly one architecture migration: a non-plastic Archie
Hybrid checkpoint may initialize the same model with a new delta-memory module.
Every pre-existing tensor must match; only `plastic_norm.*` and
`plastic_memory.*` may be newly initialized. Any wider mismatch fails closed and
the receipt records `warm_start_mode: plastic-module-added`.
The launcher lowers the default batch from 32 to 8 for this path because the
differentiable memory history adds activation pressure on a 6GB GPU. Override it
only after calibration.

Wait for the current CUDA job to finish, then start a new state directory:

```powershell
wsl bash -lc "ARCHIE_STATE=/home/awesomekai/archie-generative-v5-plastic ARCHIE_BASE_MODEL='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-next/archie-hybrid-generative-next.pt' ARCHIE_EXPORT_DIR='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-plastic' ARCHIE_PLASTIC_MODE=delta ARCHIE_PLASTIC_RANK=16 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh'"
```

Changing plasticity, sources, or corpus contents requires a new `ARCHIE_STATE`.
Do not point a plastic configuration at an existing non-plastic training state.

## Carry and inspect fast state

Create a state artifact from one interaction:

```powershell
wsl bash -lc "cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill' && CUDA_VISIBLE_DEVICES='' PYTHONPATH=. /home/awesomekai/.venv-archie-cuda/bin/python infer_archie_hybrid.py --model '../../returns/generative-plastic/archie-hybrid-generative-next.pt' --prompt 'Evidence from the current environment:' --max-new-tokens 48 --plastic-state-out /home/awesomekai/archie-memory/session-001.pt"
```

Continue from it and emit the next state:

```powershell
wsl bash -lc "cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill' && CUDA_VISIBLE_DEVICES='' PYTHONPATH=. /home/awesomekai/.venv-archie-cuda/bin/python infer_archie_hybrid.py --model '../../returns/generative-plastic/archie-hybrid-generative-next.pt' --prompt 'A later observation changes the likely mechanism:' --max-new-tokens 48 --plastic-state-in /home/awesomekai/archie-memory/session-001.pt --plastic-state-out /home/awesomekai/archie-memory/session-002.pt"
```

State artifacts use `archie-plastic-state/v1` and are bound to the exact model
SHA-256. State from another model is rejected rather than coerced.

## Repository ecology

`repo_ecology.py` turns repository action selection into measured experience:

- archive one exact Git commit into disposable snapshots;
- apply adversarial environment mutations without changing protected evaluators;
- let the existing emergent policy choose among bounded candidate patches;
- execute every candidate, including the actions Archie did not choose;
- run the frozen evaluator with path bounds and a timeout;
- emit one verified episode per mutation with chosen and counterfactual returns;
- preserve tree hashes, changed paths, logs, objective components, and receipts.

Run a prepared manifest:

```powershell
wsl bash -lc "cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train' && CUDA_VISIBLE_DEVICES='' /home/awesomekai/.venv-archie-cuda/bin/python foundry/archie-native/repo_ecology.py --manifest /home/awesomekai/archie-ecology/repair.json --output /home/awesomekai/archie-ecology/runs/repair-001 --policy-model returns/emergent-final/archie-emergent-policy.pt --policy-device cpu"
```

The optional manifest `objective_weights` prevents success from collapsing into
one universal task-completion score. Built-in bounded components are
`verified_outcome`, `boundary_integrity`, `causal_effect`, and `efficiency`.
Frozen evaluators may write additional bounded metrics such as `transfer`,
`compression`, or `calibration` to the path in `ARCHIE_ECOLOGY_METRICS` using:

```json
{
  "schema": "archie-repository-ecology-metrics/v1",
  "metrics": {"transfer": 0.72, "compression": 0.41}
}
```

Weights must retain positive verification and boundary-integrity terms. Missing,
invalid, or out-of-range metrics fail the branch. The full vector remains in the
episode even though the current compact policy trains its scalar action-value
head on the manifest-authored weighted return.

## Train across mechanisms, not templates

Combine ecology episode files, then hold out whole groups:

```powershell
wsl bash -lc "cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train' && CUDA_VISIBLE_DEVICES='' /home/awesomekai/.venv-archie-cuda/bin/python foundry/archie-native/train_emergent_policy.py --episodes /home/awesomekai/archie-ecology/curriculum.jsonl --output returns/emergent-plastic/archie-emergent-policy.pt --steps 600 --batch 32 --holdout-axis repository_id --device cpu"
```

Use `repository_id`, `mechanism_id`, or `task_family` holdouts. The action target
is the best measured branch, not automatically the teacher's chosen action. The
counterfactual head fits returns for every executed alternative.

## Plasticity admission gate

A plastic language model is not promoted because its state changes. Supply a
frozen, training-excluded support-to-query suite to the matched-time campaign:

```powershell
wsl bash -lc "ARCHIE_PLASTIC_SUITE=/home/awesomekai/archie-evals/plastic-transfer.frozen.json bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_research.sh'"
```

The suite must contain at least three cases with repository, mechanism, and task
family IDs. A plastic candidate is ineligible for selection unless support state
improves frozen query bits per byte by the configured margin on discovery and
replication seeds.

## Purpose and safety boundary

Archie can now adapt state, choose actions, observe causal outcomes, learn from
unchosen alternatives, and consolidate verified experience. It still does not
invent its own terminal authority, rewrite durable weights outside training,
prove that a reward captures a life purpose, or become conscious because the
code uses biological language. Repository ecology uses disposable Git snapshots,
path checks, and process timeouts; it is not an OS or network sandbox and must
not execute untrusted repositories.
