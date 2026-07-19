# Native Archie Hydra

Archie Hydra is a language model implemented and initialized entirely inside this repository. It does not load Qwen, Mamba checkpoints, Hugging Face model weights, a teacher model, or distilled outputs.

The hexadecimal value `8d4744f9e13072f4920c326350fa81eedb74eae9` used by earlier experiments is a Qwen3-1.7B checkpoint revision, not a commit in this repository. Commands that try to `git checkout` that value, request 128 runners, or call absent `self_play.py`, `distill_from_oracle.py`, and `admit.py` entrypoints are not an executable Archie training plan.

## Architecture

The network alternates three input-selective state-space blocks with one causal-attention block. Each state-space block contains a learned gate, causal depthwise convolution, input-dependent decay/input/readout parameters, a diagonal recurrent state, a direct path, and an output projection. Each fourth block uses multi-head causal attention with rotary positions. Every block also includes RMSNorm, a SwiGLU feed-forward network, dropout, and depth-scaled residuals. The token embedding and language-model head share weights.

The tokenizer is a deterministic 260-symbol UTF-8 byte vocabulary: 256 literal byte values plus padding, beginning-of-stream, end-of-stream, and file-separator symbols. Every checked-in textual byte can therefore be represented without external tokenizer assets or unknown tokens.

## Model sizes

| Preset | Parameters | Purpose |
| --- | ---: | --- |
| `test` | 186,632 | Forward/backward/generation contract |
| `hosted` | 25,505,964 | Real GitHub-hosted CPU training |
| `large` | 228,015,792 | Larger CPU or GPU host |
| `huge` | 2,424,398,688 | Future multi-accelerator pretraining |

The full hosted burn trains the 25.5M-parameter preset because it can make genuine optimizer progress on standard public-repository runners. Merely instantiating an oversized parameter count would not create a more capable model.

## Corpus

The trainer walks the exact checked-out repository and deterministically includes source code, tests, documentation, configuration, structured text, scripts, and web assets. It excludes Git metadata, dependencies, generated builds, caches, model outputs, checkpoints, binary files, lockfiles, and unusually large individual files.

Every retained file is preceded by a path marker. File-content digests assign the train/development split, and the corpus manifest records every included path, byte count, digest, split, and final token-stream digest.

## Full hosted training burn

The Actions workflow runs one contract job and three sequential training phases. Each training phase has a 320-minute internal deadline under the hosted-job limit. Phase artifacts carry the latest model, optimizer, RNG state, history, corpus manifest, generated sample, and receipt into the next phase.

The shared target across all phases is:

- random initialization;
- 25,505,964 trainable parameters;
- sequence length 256;
- batch 2 with four-step gradient accumulation;
- AdamW with gradient clipping, warmup, and cosine decay;
- periodic held-out byte perplexity;
- best and latest checkpoints;
- up to 8,000 optimizer steps or 40 corpus epochs;
- up to 960 minutes of bounded training time across three hosted jobs.

A phase that reaches the target early is still safely resumable: later phases load the completed checkpoint, emit a fresh exact-head receipt, and return without inventing more updates.

## Local commands

```bash
python foundry/archie-native/train_hydra.py --selftest

python foundry/archie-native/train_hydra.py \
  --repo . \
  --output native-hydra-output \
  --preset hosted \
  --seq 256 \
  --batch 2 \
  --accum 4 \
  --epochs 40 \
  --max-steps 8000 \
  --minutes 320

python foundry/archie-native/train_hydra.py \
  --repo . \
  --output native-hydra-output \
  --preset hosted \
  --seq 256 \
  --batch 2 \
  --accum 4 \
  --epochs 40 \
  --max-steps 8000 \
  --minutes 320 \
  --resume
```

## Evidence boundary

A completed artifact proves that the named randomly initialized network received real gradient updates on the manifest-bound repository corpus and records held-out movement. It does not by itself prove convergence, broad language competence, superiority to pretrained foundation models, safe deployment, quantization retention, independent reproduction, or admission. Every receipt therefore remains `promotion: not-admitted` pending evaluation and human review.
