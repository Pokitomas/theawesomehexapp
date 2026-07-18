# Archie Lite: CPU-first local inference

Archie Lite is the consumer path for running a small quantized GGUF model on an ordinary Linux computer without CUDA.

It does not train a foundation model or claim that a small local model is generally intelligent. It makes local inference practical and predictable by doing four concrete things before execution:

1. reads bounded GGUF architecture metadata without loading the model into JavaScript memory;
2. computes KV-cache bytes per token from layer count, grouped-query attention heads, and key/value head dimensions;
3. reserves operating-system and runtime memory, then caps the context window to the remaining RAM budget;
4. invokes `llama-cli` with CPU-only `-ngl 0`, bounded threads, and a bounded batch.

## Linux install

```bash
curl -fsSL https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/scripts/install-archie-lite-linux.sh | bash
```

The installer builds the pinned llama.cpp `b10067` CPU target with CUDA disabled and installs Archie from the repository. Node.js 20+, Git, CMake, a C++ compiler, and npm must already be available.

No model is downloaded automatically. Choose a GGUF model whose license you accept. For machines with 8 GB of RAM, start with a model below roughly 2B parameters in Q4_K_M or a smaller quantization. Larger models may run but will leave less room for context and will be slower.

## Inspect before running

```bash
archie-lite doctor
archie-lite inspect --model ~/Models/model.gguf
```

The inspection result includes:

- model bytes and GGUF architecture metadata;
- computed KV-cache bytes per token;
- conservative memory budget and reserved bytes;
- maximum safe context;
- CPU thread and batch recommendations;
- whether the minimum 512-token context fits conservatively.

## Run

```bash
archie-lite run \
  --model ~/Models/model.gguf \
  --prompt "Plan the safest way to repair this repository" \
  --max-tokens 256
```

The same surface is available through `archie lite`:

```bash
archie lite inspect --model ~/Models/model.gguf
archie lite run --model ~/Models/model.gguf --prompt "Summarize this task"
```

Use `--context N` to request a smaller context. Archie caps an oversized request to the computed safe maximum. `--force-context` overrides that cap and is deliberately explicit because it can cause memory pressure or process termination.

`--dry-run` prints the exact llama.cpp command and memory plan without starting inference.

## Mathematical boundary

For grouped-query attention, Archie estimates the F16 KV cache per token as:

```text
bytes/token = layers × kv_heads × (key_head_dim + value_head_dim) × 2 bytes
```

When the GGUF file lacks enough architecture metadata, Archie uses a conservative 256 KiB-per-token fallback. The estimate is a planning bound, not a guarantee of exact peak resident memory for every llama.cpp build or model architecture.

## Learning boundary

Archie Lite reduces repeated compute through the existing local specialist mixture and outcome reliability loop. Reused plans begin with pure similarity. Once verified outcomes exist, each specialist's similarity score is multiplied by its posterior reliability factor, and failed specialists can be reranked or gated out on later runs. This is permanent local adaptation of routing behavior, not neural weight training.
