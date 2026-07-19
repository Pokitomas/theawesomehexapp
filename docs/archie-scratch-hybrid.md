# Archie from-scratch selective SSM + local-attention trainer

This lane trains a language model from random initialization. It does not download Qwen or any other pretrained checkpoint, request teacher logits, or optimize a distillation objective.

## Architecture

`ArchieHybridLM` alternates two auditable stock-PyTorch mixers:

- input-selective diagonal state-space recurrence with a causal depthwise convolution, low-rank selection controls, learned decay, and a chunked parallel affine scan;
- periodic grouped-query local causal attention with rotary positions.

Every block also uses pre-normalization, SwiGLU, tied input/output embeddings, gradient checkpointing, full-parameter AdamW, clipping, warmup, and cosine decay. Presets scale from a 133K-parameter executable micro model through a 306M-parameter large model and a larger accelerator-only xlarge preset.

## Tokenizer and corpus storage

The tokenizer is deterministic UTF-8 bytes plus four special IDs:

| Token | ID |
|---|---:|
| PAD | 256 |
| BOS | 257 |
| EOS | 258 |
| SEP | 259 |

Corpus files use little-endian unsigned 16-bit storage (`<u2`). This is required: raw byte files cannot represent IDs above 255. Each corpus has a SHA-256-bound metadata sidecar recording token count, document count, source digest, dtype, endianness, and tokenizer identity.

The Actions lane combines repository text/code with a bounded public FineWeb-Edu stream. The model sees raw text only. Corpus size and remote sources are explicit command inputs, so a receipt can reproduce the exact byte stream.

## Validation

```bash
PYTHONPATH=foundry/archie-distill \
  python foundry/archie-distill/test_archie_hybrid_contract.py

python foundry/archie-distill/train_archie_hybrid.py \
  --tiny-selftest \
  --state-dir /tmp/archie-scratch-selftest
```

The self-test performs fresh forward/backward training, writes a checkpoint, starts a second process, resumes from that checkpoint, evaluates, exports, and generates. It also proves that IDs 256–259 survive corpus serialization.

## Full raw-corpus run

```bash
python foundry/archie-distill/train_archie_hybrid.py \
  --build-corpus \
  --source . \
  --hf-source 'HuggingFaceFW/fineweb-edu|sample-10BT|train|text|100000' \
  --max-corpus-tokens 100000000 \
  --state-dir pilot_state \
  --preset auto \
  --seq-len 512 \
  --batch-size 2 \
  --grad-accum 8 \
  --max-steps 50000 \
  --deadline-minutes 320
```

Rerunning the same command resumes only when model configuration and corpus SHA-256 still match. The export includes `model.pt`, `config.json`, `tokenizer.json`, `sample.txt`, and a training receipt. Promotion remains `not-admitted` until independent capability and safety evaluation.
