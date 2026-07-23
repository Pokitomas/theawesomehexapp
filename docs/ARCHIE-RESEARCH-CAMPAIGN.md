# Archie falsifiable research campaign

The ordinary `run_archie_next.sh` launcher does not ideate. It executes one
chosen model, tokenizer, corpus, objective, and CUDA path. Making that run ten
times longer tests training duration, not whether the choices were good.

`run_archie_research.sh` is the separate mechanism-search lane. It spends equal
GPU time on isolated candidates, evaluates held-out source-separated records,
replicates the strongest two candidates with a second seed, packages the
replicated winner, and emits failed gates instead of flattering prose.

## Four claims under test

The campaign makes these claims falsifiable:

1. **Hybrid superiority.** The selective-state/local-attention hybrid must beat
   geometry-matched all-attention and all-state-space comparators by at least
   three percent in held-out bits per original byte.
2. **Governed-corpus effect.** The governed raw/reconstruction/receipt
   curriculum must beat ordinary unwrapped source-code training by at least
   three percent when both models are evaluated on the same governed
   development records. A separate unwrapped all-source ablation reduces the
   code-only confound.
3. **Measured autonomous improvement.** The predeclared campaign must choose the
   same winner before and after a seed change, and that winner must beat the
   baseline by at least three percent.
4. **Useful plasticity.** A delta-fast-weight candidate must improve query bits
   per byte after receiving support context on a frozen, training-excluded suite.
   It must pass on discovery and replication seeds; changing state alone is not
   evidence of useful adaptation.

Passing a gate is pilot evidence only. It does not establish planning, agency,
general intelligence, or superiority outside the frozen development
distribution.

## Executable search dimensions

The current campaign actually changes weights and measures:

- mixer: Archie hybrid, local attention only, or selective state space only;
- plasticity: reset-only hidden state or learned causal delta fast weights;
- corpus: governed tasks, unwrapped all-source text/code, or raw code only;
- tokenizer: UTF-8 bytes or a reversible tokenizer containing byte fallback and
  corpus-learned nonrecursive byte pairs;
- objective normalization: loss per token or loss per represented byte;
- CUDA execution: FP16/BF16/FP32, gradient recomputation, TF32 where supported,
  and optional `torch.compile`;
- optimization: candidate-specific learning rate with fixed AdamW controls.

Bits per byte, not token loss, ranks different tokenizers. Each pair vocabulary
is learned from training records only and is reused unchanged on development
records.

## One command

From Windows PowerShell:

```powershell
cd "C:\Users\AwesomeKai\Documents\New project\theawesomehexapp-archie-train"
wsl bash "/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_research.sh"
```

The default is eight discovery candidates at eight minutes each followed by
second-seed replication of the best two: about 80 GPU minutes plus corpus
construction and final evaluation. It uses the `tiny` model for mechanism
search so bad ideas are rejected before spending the `small` model budget.

The plastic candidate trains without a suite but cannot be selected without one.
Set `ARCHIE_PLASTIC_SUITE` to a frozen `archie-plastic-transfer-suite/v1` JSON
file. The campaign hashes the suite into its immutable contract.

Dry run:

```powershell
wsl bash -lc "ARCHIE_DRY_RUN=1 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_research.sh'"
```

More serious search:

```powershell
wsl bash -lc "ARCHIE_RESEARCH_STATE=/home/awesomekai/archie-hybrid-research-v2 ARCHIE_RESEARCH_PRESET=small ARCHIE_RESEARCH_BATCH_SIZE=16 ARCHIE_RESEARCH_CANDIDATE_MINUTES=20 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_research.sh'"
```

Use a new state directory when changing candidate duration, preset, corpus, or
campaign definition. Completed candidates are reused; interrupted candidates
resume their own checkpoint.

The launcher refuses to start while another Archie trainer, research campaign,
or VRAM calibrator is active. This prevents two independent processes from
silently sharing the 6GB GPU and invalidating both timing evidence and the main
run's throughput. `ARCHIE_ALLOW_CONCURRENT_GPU=1` exists only for a deliberate
override.

## Read the result

```powershell
$campaign = Get-Content "returns\hybrid-research\campaign-receipt.json" -Raw | ConvertFrom-Json
$campaign.selected_candidate
$campaign.claim_tests
$campaign.discovery | Select-Object id,role,final_eval_bits_per_byte,bytes_per_second,parameters
$campaign.replicated_ranking
```

Every selected model remains `research-candidate-not-admitted`. Matched GPU
wall time is a practical compute proxy on this machine; it is not exact FLOPs,
energy, or joules. Parameter counts, processed tokens/bytes, throughput, peak
VRAM, nonfinite updates, model hashes, and receipt hashes remain visible.

## Customize the research thesis

Set `ARCHIE_RESEARCH_CAMPAIGN_JSON` to a JSON file containing a `candidates`
array. Candidate fields are:

- required: `id`, `role`, `hypothesis`, `corpus`, `mixer_mode`;
- optional: `evaluation_corpus`, `loss_normalization`, `learning_rate`,
  `gradient_checkpointing`, `amp_dtype`, `tf32`, `compile`, `plastic_mode`, and
  `plastic_rank`;
- corpus names: `governed_byte`, `raw_all_byte`, `raw_code_byte`, and
  `governed_pairgram`;
- mixer names: `hybrid`, `attention`, and `ssm`.

Keep the built-in baseline/comparator IDs if the standard claim gates should be
computed. Unknown mechanisms fail closed rather than silently becoming labels
for the same implementation.

## Honest autonomy boundary

The campaign autonomously executes, measures, rejects, ranks, replicates, and
packages candidates. It does not autonomously write a correct new CUDA kernel,
invent a tokenizer family, prove a distillation objective, or decide that a
pretty sample is intelligence. Those ideas still require mechanism code plus a
new falsification probe.

The repository now contains a separate ecology lane for whole-repository and
task-family holdouts, learned counterfactual action values, real repository
transitions, adversarial mutations, and recurrent fast state. High-leverage next
candidates are teacher-logit distillation versus trace-only distillation,
quantization-aware training versus post-training quantization, objective-vector
prediction, and measured custom Triton/CUDA kernels. None should be called an
improvement until it beats the same baseline under the same resource and
hidden-evaluation rules.

The complete plastic-state and repository-experience workflow is in
`docs/ARCHIE-PLASTIC-ORGANISM.md`.
