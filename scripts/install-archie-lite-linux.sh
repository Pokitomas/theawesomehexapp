#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "archie lite installer: Linux is required." >&2
  exit 1
fi

PREFIX="${ARCHIE_LITE_PREFIX:-$HOME/.local}"
BUILD_ROOT="${ARCHIE_LITE_BUILD_ROOT:-$HOME/.cache/archie-lite}"
LLAMA_CPP_TAG="${ARCHIE_LLAMA_CPP_TAG:-b10067}"
REPOSITORY_TARBALL="${ARCHIE_REPOSITORY_TARBALL:-https://github.com/Pokitomas/theawesomehexapp/archive/refs/heads/main.tar.gz}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "archie lite installer: missing required command: $1" >&2
    exit 1
  }
}

need git
need cmake
need npm
need node

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ -z "$node_major" || "$node_major" -lt 20 ]]; then
  echo "archie lite installer: Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT" "$PREFIX/bin"
source_dir="$BUILD_ROOT/llama.cpp-$LLAMA_CPP_TAG"
if [[ ! -d "$source_dir/.git" ]]; then
  rm -rf "$source_dir"
  git clone --depth 1 --branch "$LLAMA_CPP_TAG" https://github.com/ggml-org/llama.cpp.git "$source_dir"
else
  git -C "$source_dir" fetch --depth 1 origin "refs/tags/$LLAMA_CPP_TAG:refs/tags/$LLAMA_CPP_TAG"
  git -C "$source_dir" checkout --detach "$LLAMA_CPP_TAG"
fi

cmake -S "$source_dir" -B "$source_dir/build-archie-lite" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=OFF \
  -DGGML_NATIVE=ON \
  -DLLAMA_CURL=OFF
cmake --build "$source_dir/build-archie-lite" --config Release --target llama-cli --parallel "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
install -m 0755 "$source_dir/build-archie-lite/bin/llama-cli" "$PREFIX/bin/llama-cli"

npm install --global "$REPOSITORY_TARBALL"

cat <<MESSAGE
Archie Lite installed.

Add this to your shell profile when $PREFIX/bin is not already on PATH:
  export PATH="$PREFIX/bin:\$PATH"

Then use a small quantized GGUF model:
  archie lite doctor
  archie lite inspect --model ~/Models/model.gguf
  archie lite run --model ~/Models/model.gguf --prompt "Plan my next task"

The installer compiled llama.cpp with CUDA disabled. Archie Lite also forces -ngl 0
and calculates a conservative context limit from RAM and GGUF KV-cache metadata.
MESSAGE
