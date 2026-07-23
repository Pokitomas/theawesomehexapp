# Archie training survival runbook

For broad provenance-bound pretraining with archive ingestion and aggressive deduplication, begin with `docs/ARCHIE-SIDEPUS-BROAD-DIET.md`. Its Sidepus export can replace the local source scan while preserving this runbook’s checkpoint, receipt, and resume contracts.

This file is the handoff if the original coding session disappears. The commands
are written for Windows PowerShell with WSL2 and the existing RTX 2060 setup.

## What the model is

Archie Hybrid is a `24,140,160`-parameter autoregressive byte-language model. It
predicts the next UTF-8 byte from every byte before it. Its vocabulary is only
the 256 byte values plus padding, beginning, ending, and separator symbols.

The network contains twelve residual blocks. Most blocks use Archie's
input-selective state-space mixer; every fourth block uses local causal
grouped-query attention. The state-space scan is a division-free associative
scan, because the original prefix-division scan produced NaN gradients after 50
updates. The admitted router and the generative model are separate components:
the router chooses a mode or protocol, while this model generates text.

This is not Llama, a downloaded pretrained checkpoint, an API wrapper, or a
template router. The selected checkpoint was trained locally from scratch and is
stored at:

`returns/generative-final/archie-hybrid-generative.pt`

## What training actually does

1. Explicit source folders are scanned for text and code files.
2. Binary files, unknown extensions, oversized files, dependency folders, build
   output, virtual environments, and Git internals are skipped.
3. Every accepted file is assigned wholly to training or development by a
   deterministic content hash. No source file appears in both splits.
4. The next-stage builder creates three kinds of records:
   - governed raw documents for ordinary continuation;
   - missing-span tasks where Archie must reconstruct exact code or prose;
   - deterministic provenance tasks that emit artifact hashes and protocols.
5. Records become UTF-8 bytes and are packed into `uint16` corpus files.
6. The selected model initializes all 24.14M weights, but a new optimizer and
   sampler are created for this new curriculum.
7. Cross-entropy next-byte loss updates every model parameter locally.
   With `ARCHIE_PLASTIC_MODE=delta`, the model also learns a bounded causal
   fast-weight memory that can change during inference without optimizer steps.
8. A separate development corpus measures generalization every 50 updates.
9. Checkpoints preserve weights, optimizer, scheduler, scaler, sampler positions,
   and CPU/CUDA random-number state. Running the same command resumes exactly.
10. Every export includes hashes, metrics, hardware identity, corpus identity,
    skipped-gradient counts, a sample, and an explicit non-admission boundary.

No OpenAI or other token API is called anywhere in this process.

## One-command next training

Open PowerShell and run:

```powershell
cd "C:\Users\AwesomeKai\Documents\New project\theawesomehexapp-archie-train"
wsl bash "/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh"
```

The default next stage is intentionally ambitious but bounded:

- warm-start from the selected 750-step Archie model;
- rebuild a source-level 95/5 train/development corpus;
- add three span-reconstruction tasks per accepted document;
- train 1,500 updates, or `49,152,000` sampled tokens;
- use context `1024`, batch `32`, FP16, and zero accumulation;
- save and evaluate every 50 updates;
- stop after three hours if the target has not finished;
- fail closed after eight consecutive nonfinite gradients;
- export to `returns/generative-next/`.

Run the exact same command again after a deadline, reboot, or interruption. It
reuses the sealed corpus and resumes the checkpoint. Do not add `--no-resume`.
The launcher refuses to start if another Archie GPU process is active, unless
`ARCHIE_ALLOW_CONCURRENT_GPU=1` is explicitly set.

## Check before spending hours

This validates paths, CUDA, model identity, defaults, and extra sources without
building a corpus or changing weights:

```powershell
wsl bash -lc "ARCHIE_DRY_RUN=1 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh'"
```

Monitor the GPU in a second PowerShell window:

```powershell
nvidia-smi -l 2
```

## Add your own training material

First convert a Windows path into a WSL path:

```powershell
wsl wslpath -a "D:\ArchieCorpus"
```

Then pass the returned path to the launcher:

```powershell
wsl bash "/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh" "/mnt/d/ArchieCorpus"
```

Useful inputs are concise, correct, and behaviorally relevant:

- verified prompt/response or observation/action/receipt traces;
- the code and documents Archie should operate on;
- examples of abstention, repair, rollback, and evidence checking;
- hard mixed-intent contrasts where one changed phrase changes the right action;
- high-quality writing or domain material you have the right to use;
- modality adapter outputs represented as governed text metadata.

For supervised behavior, use explicit records in `.txt`, `.md`, `.json`, or
`.jsonl` files, for example:

```text
<archie:task kind="verified_dialogue">
<prompt>Inspect the completed run before claiming success.</prompt>
<archie:response>Read the receipt, compare metrics, and report the evidence boundary.</archie:response>
<verified>true</verified>
</archie:task>
```

Do not feed passwords, private keys, browser profiles, private messages without
consent, random generated sludge, duplicate dependency trees, model binaries, or
logs whose correct interpretation is unknown. More bytes are not automatically
more intelligence; low-quality repetition consumes the same gradient budget as
useful evidence.

## Customize the ambitious run

Set variables inside the WSL command. This example trains 2,000 updates for up to
four hours with four reconstruction tasks per document:

```powershell
wsl bash -lc "ARCHIE_STATE=/home/awesomekai/archie-generative-v4 ARCHIE_MAX_STEPS=2000 ARCHIE_DEADLINE_MINUTES=240 ARCHIE_SPAN_TASKS=4 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh' '/mnt/d/ArchieCorpus'"
```

Important controls:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `ARCHIE_STATE` | `/home/awesomekai/archie-generative-v3` | Corpus and resumable checkpoint directory |
| `ARCHIE_MAX_STEPS` | `1500` | Total optimizer updates in this stage |
| `ARCHIE_DEADLINE_MINUTES` | `180` | Wall-clock guard for each invocation |
| `ARCHIE_BATCH_SIZE` | `32` (`8` with plasticity) | Sequences per update; conservative plastic default |
| `ARCHIE_SEQUENCE_LENGTH` | `1024` | Byte context length |
| `ARCHIE_LEARNING_RATE` | `0.00006` | Warm-start peak learning rate |
| `ARCHIE_WARMUP_STEPS` | `50` | Gradual learning-rate ramp |
| `ARCHIE_SPAN_TASKS` | `3` | Reconstruction tasks generated per document |
| `ARCHIE_DEVELOPMENT_PERCENT` | `5` | Whole source files reserved for evaluation |
| `ARCHIE_PLASTIC_MODE` | `none` | `delta` adds learned fast-weight memory |
| `ARCHIE_PLASTIC_RANK` | `16` | Width of the dynamic memory state |
| `ARCHIE_REBUILD_CORPUS` | `0` | Set to `1` to rescan sources |
| `ARCHIE_DRY_RUN` | `0` | Set to `1` for validation only |

If you change source contents after training begins, use a new `ARCHIE_STATE`.
The checkpoint deliberately rejects a different corpus digest rather than
silently mixing lineages.

## Upgrade the trained model with fast weights

Use a new state directory after the current non-plastic run completes:

```powershell
wsl bash -lc "ARCHIE_STATE=/home/awesomekai/archie-generative-v5-plastic ARCHIE_BASE_MODEL='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-next/archie-hybrid-generative-next.pt' ARCHIE_EXPORT_DIR='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-plastic' ARCHIE_PLASTIC_MODE=delta bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_next.sh'"
```

This is a narrow migration, not a loose partial load. Every old tensor is copied
exactly and only the new plastic module may be absent from the source checkpoint.
The training receipt exposes the migration mode. Persistent state commands,
repository counterfactual training, and the plastic admission gate are documented
in `docs/ARCHIE-PLASTIC-ORGANISM.md`.

## Let Archie negotiate the next corpus

`run_archie_pursuit.sh` wraps the same builder and trainer with a curriculum
exchange. The trained student requests supplemental domain focus from its own
probabilities; a frozen parent comparison counters that bid; held-out settlement
updates a persistent pursuit ledger. Baseline replay remains intact.

The full command, contract schemas, controls, and inspection commands are in
`docs/ARCHIE-CURRICULUM-EXCHANGE.md`.

## Read the result

```powershell
$receipt = Get-Content "returns\generative-next\training-receipt.json" -Raw | ConvertFrom-Json
$receipt.model
$receipt.optimization | Select-Object step,tokens_seen,best_eval_loss,final_eval_loss,skipped_nonfinite_steps,stop_reason
$receipt.sample
```

Generate locally:

```powershell
wsl bash -lc "cd '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill' && PYTHONPATH=. /home/awesomekai/.venv-archie-cuda/bin/python infer_archie_hybrid.py --model '../../returns/generative-next/archie-hybrid-generative-next.pt' --prompt 'Given the evidence, the next useful action is' --max-new-tokens 64 --temperature 0.65 --top-k 24"
```

## Honest expectation

The next stage should improve exact local continuation, structured receipts,
code-span recovery, and evidence-shaped generation. It will not become a frontier
chatbot from 24M parameters and tens of millions of bytes. The next high-leverage
upgrade after this stage is not merely more epochs: it is a larger governed corpus
of verified multi-step outcomes, a task-weighted sampler, and independent frozen
evaluations for generation, tool selection, repair, and abstention.

## Do not confuse training with research search

`run_archie_next.sh` deliberately trains one selected thesis. To compare
tokenizers, mixer families, governed versus raw-code curricula, and CUDA
execution paths under matched time with second-seed replication, use
`run_archie_research.sh`. The full claim gates, commands, and autonomy boundary
are in `docs/ARCHIE-RESEARCH-CAMPAIGN.md`.
