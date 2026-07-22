# Archie Real Git Experience

This lane is deliberately not a larger synthetic-instruction run. It turns committed repository history into causal neural experience.

## What Archie sees

Each episode contains only mechanically structured, repository-real evidence:

- the exact parent commit and blob identity;
- the human-written commit message;
- the parent file bytes;
- the exact unified diff derived from committed parent and successor blobs;
- a counterfactual diff borrowed unchanged from another real commit in the same temporal split.

The compiler emits no language-model-written rows, assistant conversations, invented tool results, or generated task descriptions. Structural field names make the byte stream parseable, but all semantic payload comes from Git objects.

## Learning rule

The model receives two futures after one observed state. Full model weights learn from:

1. next-token likelihood of the true committed patch;
2. a causal contrast that rewards the true patch over an unrelated real patch only from their first divergent byte onward, so shared diff headers and context cannot dominate the decision;
3. an online curiosity exchange that allocates 85% of later examples by the student's surprise, causal confusion, measured learning progress, and token price while reserving 15% for unseen real history.

This is counterfactual credit without fabricated negatives. The wrong future really happened, just elsewhere. The newest commit groups are held out together, so a file from one commit cannot leak across train and development.

## Compile real history

Run this with the host Git implementation when the repository is a Windows worktree:

```powershell
python foundry/archie-distill/compile_git_experience.py `
  --repository . `
  --output returns/git-experience-v2/data `
  --holdout-rate 0.15 `
  --max-files-per-commit 6 `
  --max-file-bytes 8192 `
  --max-patch-bytes 8192
```

The compiler freezes source hashes, rejects merges and unsuitable blobs, creates deterministic real counterfactuals, and signs train and development JSONL files in `git-experience-receipt.json`.

## Train

From WSL:

```bash
cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train'
bash foundry/archie-distill/run_archie_git_experience.sh
```

Important controls:

- `ARCHIE_GIT_STEPS`: optimizer updates;
- `ARCHIE_GIT_CURIOSITY_PROBES`: real episodes scored before allocation;
- `ARCHIE_GIT_EXPLORATION_RATE`: bounded share spent discovering unscored real episodes;
- `ARCHIE_GIT_SEQUENCE_LENGTH`: total observed-state and future budget;
- `ARCHIE_GIT_PREFERENCE_WEIGHT`: strength of true-future versus wrong-future credit;
- `ARCHIE_GIT_EXPERIENCE_STATE`: fresh Linux training directory;
- `ARCHIE_GIT_EXPERIENCE_EXPORT`: final checkpoint and receipt directory.

## Truth boundary

A lower held-out chosen loss means Archie better predicts future committed changes. Higher causal advantage and pair accuracy mean it more often distinguishes the actual successor from another real successor. Neither metric proves the original commits were correct, that Archie can autonomously edit a repository, or that its fast weights support useful continual learning. Those require independent execution and repair evaluations.

## Completed campaign

The v3 compiler sealed 1,105 real episodes from 729 commit groups with 904 training and 201 development episodes. The first full-weight round substantially improved patch prediction but regressed causal discrimination. Whole-patch causal replay also regressed and was explicitly rejected. Divergence-only replay produced a specialist task vector. A nested temporal merge search selected alpha `0.9` between the preserved patch model and that specialist.

On the newest 103 episodes, which were not used to choose alpha, the selected merge improved chosen patch loss by `0.009629555` nats/token, mean causal advantage by `0.015727140`, and pair accuracy by `0.048543689`. Selected model SHA-256: `f6a711115aeeef1f92420c20178498bbf45fff504c707dc431dcc0a86aeb7d2d`.

The subsequent public-corpus retention check regressed by `17.99%`, and fast-state plasticity improved by only `0.0539%` against a `3%` gate. The selected merge is therefore retained as a repository-transition specialist and task vector, not promoted as the general Archie checkpoint.
