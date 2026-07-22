# Archie hybrid generative model

Archie's generative lane is a 24.14M-parameter language model trained from random
initialization. It mixes selective state-space blocks with local grouped-query
attention and uses a deterministic UTF-8 byte tokenizer. It does not load a
pretrained model, teacher logits, or an external inference API.

## Selected local arrangement

- model preset: `small` (`24,140,160` parameters);
- context: `1024` byte tokens;
- microbatch: `32` sequences;
- effective update: `32,768` tokens with no accumulation;
- precision: FP16 with gradient scaling;
- scan: division-free associative SSM chunks of `128`;
- training: `750` applied updates and `24,576,000` sampled tokens;
- corpus: `20,244,623` tokens from `1,207` governed local documents;
- hardware: NVIDIA GeForce RTX 2060 under WSL2;
- nonfinite updates: `0` in the selected run.

## Inference

```bash
python foundry/archie-distill/infer_archie_hybrid.py \
  --model returns/generative-final/archie-hybrid-generative.pt \
  --prompt "Archie analyzes the evidence and" \
  --max-new-tokens 64 \
  --temperature 0.65 \
  --top-k 24
```

The full resumable optimizer checkpoint remains at
`/home/awesomekai/archie-generative-v2/final-associative-v1/run/checkpoint.pt`.
Rerunning the recorded command resumes weights, optimizer, scheduler, samplers,
scaler, and CPU/CUDA random-number state.

## Evidence boundary

The selected model is genuinely autoregressive, but its short probes remain
fragmentary and corpus-shaped. The reported evaluation sampler draws different
windows from the training corpus rather than an independently frozen document
split. This model is therefore a trained local generator and research artifact,
not an admitted chatbot or general-intelligence claim.
