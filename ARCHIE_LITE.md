# Archie lite

Archie lite is the concrete low-compute execution path for an already installed GGUF model. It is available under both command spellings:

```bash
archie-lite plan <id@version>
archie_lite plan <id@version>

archie-lite run <id@version> --prompt "Explain the current objective."
archie_lite <id@version> --prompt-file ./prompt.txt
```

## One-command Linux runtime install

On glibc-based x86_64 or arm64 Linux with Node.js 20+, npm, curl, tar, and `sha256sum`:

```bash
curl -fsSL https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/scripts/install-archie-lite-linux.sh | bash
```

The installer:

1. resolves the pinned official llama.cpp CPU release `b10067` for the machine architecture;
2. obtains the exact asset URL and SHA-256 digest from GitHub's release API;
3. verifies the archive before extraction and rejects unsafe archive paths;
4. installs the complete runner and its shared libraries under `~/.local/lib/archie/llama.cpp/`;
5. installs a managed `~/.local/bin/llama-cli` wrapper;
6. resolves Archie's current `main` commit and installs that exact commit under `~/.local` rather than an unbound moving archive;
7. verifies both `llama-cli --version` and `archie-lite --help`;
8. writes an `archie-lite-linux-install-receipt/v1` under `~/.local/share/archie/install-receipts/`.

Override the prefix or pinned llama.cpp release explicitly:

```bash
ARCHIE_LITE_PREFIX="$HOME/apps/archie" \
ARCHIE_LLAMA_CPP_RELEASE=b10067 \
  bash scripts/install-archie-lite-linux.sh
```

The installer does **not** download a model. Model bytes still enter Archie only through a signed manifest and a trusted publisher key:

```bash
archie pull /path/to/model-manifest.json \
  --trust-key /path/to/publisher-public.pem
archie-lite plan <id@version>
archie-lite run <id@version> --prompt "Explain the current objective."
```

Use `bash scripts/install-archie-lite-linux.sh --help` for prerequisites and replacement controls. The official Ubuntu CPU assets require glibc; musl systems must provide a compatible `llama-cli` separately.

## What the plan proves

Before inference, Archie lite:

1. opens the installed GGUF artifact and reads only bounded model metadata;
2. extracts architecture, declared context, layer count, embedding width, attention heads, and KV heads;
3. calculates raw and safety-budgeted KV-cache bytes per token;
4. measures total and currently free machine RAM;
5. reserves operating-system and runtime headroom;
6. caps context to the smallest of the requested, manifest, GGUF, and RAM limits;
7. fails closed when even the configured minimum context cannot fit;
8. rejects competing accelerator arguments, hides accelerator devices, selects `--device none`, sets `--gpu-layers 0`, passes explicit negative flags for KV-cache, host-operation, and multimodal-projector offload, and turns automatic device fitting off;
9. writes a digest-bound plan receipt and, after execution, a lite run receipt linked to the normal Archie model-run receipt.

The parser intentionally stops before large tokenizer arrays once the required model dimensions are known. It does not load model tensors or the complete GGUF into Node memory.

## Controls

```text
--context <tokens>            requested context before caps
--kv-element-bytes <n>        1, 2, 4, or 8; default 2
--kv-safety-factor <number>   default 1.10
--reserve-ratio <number>      fraction of total RAM kept for the OS; default 0.25
--reserve-bytes <n>           absolute reserve floor
--runtime-overhead-bytes <n>  optional explicit runtime-overhead budget
--free-ram-utilization <n>    fraction of current free RAM Archie may budget; default 0.90
--minimum-context <tokens>    fail-closed floor; default 256
```

Run `archie-lite --help` for generation and runner flags.

## Requirements

- The model must already be installed through Archie's signed model-manifest path.
- `model.format` must be `gguf`.
- The manifest must explicitly admit the `cpu` backend.
- The GGUF must use supported v2 or v3 metadata and include the architecture dimensions needed for KV budgeting.
- The runner must be a compatible llama.cpp command, normally `llama-cli` or `ARCHIE_RUNNER`.

## Receipts

Linux installer receipts are stored under:

```text
~/.local/share/archie/install-receipts/
```

Plans are stored under:

```text
$ARCHIE_HOME/receipts/lite-plans/
```

Runs are stored under:

```text
$ARCHIE_HOME/receipts/lite-runs/
$ARCHIE_HOME/receipts/runs/
```

The lite receipt binds the model and artifact digests, plan receipt, selected context, CPU enforcement, and normal run receipt.

## Truth boundary

A successful installer receipt proves that the exact Archie commit and digest-verified CPU runner were installed. It does not prove model presence or capability. A successful Archie lite plan proves metadata inspection, conservative RAM budgeting, and CPU-only runner configuration. A successful run proves only that the bound local process completed under that plan. None of these results proves model quality, speed, neural training, capability improvement, hidden-evaluation success, admission, or production promotion.
