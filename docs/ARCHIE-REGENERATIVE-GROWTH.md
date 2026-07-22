# Archie regenerative growth

This lane tests one narrow claim: after cheaper interventions repeatedly fail and measured improvement plateaus, a student may benefit from additional structural capacity that inherits the parent's behavior instead of restarting from random initialization.

It is not a rule that rejection means “make the model bigger.” That would convert every data, objective, representation, systems, or evaluation mistake into parameter inflation. The governor fails closed unless the evidence records repeated failed interventions and a sufficiently small recent gain, or the operator explicitly forces a bounded research experiment.

## Birth contract

`archie_regenerative_growth.py` grows depth while preserving the parent's mixer topology.

For hybrid models, whole `attention_every` groups are inserted so inherited attention and SSM blocks remain in the same mixer phase. Every new block is initialized normally internally, but its mixer output projection and FFN down projection are zeroed. The block is therefore an exact residual identity at birth while retaining trainable latent capacity.

The child is rejected before training unless multiple deterministic token probes keep parent and child logits within the declared tolerance. The receipt records the parent hash, block mapping, inserted block indices, source and target parameter counts, initialization seed, and logit deltas.

## Two-stage education

The first phase freezes the inherited brain and trains only the inserted blocks. This is probation: new capacity must become useful without immediately rewriting preserved knowledge.

The second phase unfreezes the whole descendant only when probation stays inside the maximum allowed regression. Final evaluation reuses identical deterministic corpus windows for parent and child. A separate retention corpus is required by default.

A cycle can end only as:

- `rejected`, when birth, probation, capability, or retention gates fail; or
- `research-candidate-not-admitted`, when the bounded descendant clears the declared gates.

No result is an architectural promotion without replication, matched-resource baselines, execution tests, and the broader admission process.

## Evidence input

The evidence JSON may be a purpose-built diagnosis or an existing nested receipt. The governor reads explicit `failed_interventions` and plateau fields when present, and can count nested failed or rejected gates.

A minimal diagnosis is:

```json
{
  "schema": "archie-capacity-diagnosis/v1",
  "failed_interventions": 3,
  "plateau_relative_gain": 0.001,
  "attempts": [
    {"kind": "curriculum", "status": "rejected"},
    {"kind": "objective", "status": "rejected"},
    {"kind": "merge", "status": "rejected"}
  ]
}
```

Plan without allocating a training run:

```powershell
wsl python3 '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/archie_regenerative_growth.py' `
  --parent-model '/home/awesomekai/archie-base-114m-v1/training/run/model.pt' `
  --evidence-json '/home/awesomekai/archie-growth-evidence.json' `
  --state-dir '/home/awesomekai/archie-growth-v1' `
  --requested-parameter-multiplier 1.5 `
  --plan-only
```

Execute an approved cycle:

```powershell
wsl python3 '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/archie_regenerative_growth.py' `
  --parent-model '/home/awesomekai/archie-base-114m-v1/training/run/model.pt' `
  --evidence-json '/home/awesomekai/archie-growth-evidence.json' `
  --state-dir '/home/awesomekai/archie-growth-v1' `
  --corpus '/home/awesomekai/archie-base-114m-v1/corpus/train.u16' `
  --eval-corpus '/home/awesomekai/archie-base-114m-v1/corpus/development.u16' `
  --retention-corpus '/home/awesomekai/archie-retention/development.u16' `
  --requested-parameter-multiplier 1.5 `
  --probation-steps 200 `
  --unfreeze-steps 400
```

The default requested multiplier is translated into a legal layer quantum, not blindly into an exact parameter count. The final receipt reports the actual multiplier.

## Hostile interpretation

The mechanism is potentially useful because it separates three questions that ordinary scaling runs blur together:

1. Can a larger child inherit the exact function of the smaller parent?
2. Can only the newly added capacity learn something without damaging the parent?
3. Does full integration improve frozen capability while preserving unrelated knowledge?

A positive answer would support this specific growth procedure. It would not prove recursive self-improvement, autonomous architecture invention, general intelligence, or that further growth remains beneficial. A negative answer is valuable: it says the ceiling was probably not solved by adding depth under this curriculum and objective.
