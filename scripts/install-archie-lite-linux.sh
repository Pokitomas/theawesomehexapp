#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Install Archie Lite and a verified CPU-only llama.cpp runner for Linux.

Usage:
  bash scripts/install-archie-lite-linux.sh
  curl -fsSL https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/scripts/install-archie-lite-linux.sh | bash

Environment:
  ARCHIE_LITE_PREFIX              Install prefix. Default: $HOME/.local
  ARCHIE_LLAMA_CPP_RELEASE        Pinned llama.cpp release. Default: b10067
  ARCHIE_LITE_REPLACE_RUNNER=1    Replace a non-Archie-managed prefix/bin/llama-cli

The installer downloads no model weights. Models remain admitted through Archie's
signed manifest and trusted-publisher-key path.
EOF
}

fail() {
  printf 'archie-lite installer: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || fail "unexpected arguments; use --help"
[[ "$(uname -s)" == 'Linux' ]] || fail 'this installer supports Linux only'

for command in curl tar sha256sum node npm mktemp install find; do
  need "$command"
done

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "could not parse Node.js version: $(node --version)"
(( node_major >= 20 )) || fail "Node.js 20 or newer is required; found $(node --version)"

if command -v ldd >/dev/null 2>&1 && { ldd --version 2>&1 || true; } | grep -qi musl; then
  fail 'official Ubuntu CPU binaries require glibc; musl systems must install a compatible llama-cli separately'
fi

case "$(uname -m)" in
  x86_64|amd64) asset_arch='x64' ;;
  aarch64|arm64) asset_arch='arm64' ;;
  *) fail "unsupported Linux architecture: $(uname -m); supported: x86_64 and aarch64" ;;
esac

prefix="${ARCHIE_LITE_PREFIX:-$HOME/.local}"
release="${ARCHIE_LLAMA_CPP_RELEASE:-b10067}"
[[ "$release" =~ ^b[0-9]+$ ]] || fail 'ARCHIE_LLAMA_CPP_RELEASE must look like b10067'

asset_name="llama-${release}-bin-ubuntu-${asset_arch}.tar.gz"
release_api="https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${release}"
archie_commit_api='https://api.github.com/repos/Pokitomas/theawesomehexapp/commits/main'
temporary="$(mktemp -d "${TMPDIR:-/tmp}/archie-lite-install.XXXXXXXX")"
trap 'rm -rf "$temporary"' EXIT INT TERM

curl_json() {
  local url="$1"
  local destination="$2"
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --retry 3 --retry-all-errors \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$url" -o "$destination"
}

release_json="$temporary/llama-release.json"
curl_json "$release_api" "$release_json"

mapfile -t asset_metadata < <(node - "$release_json" "$release" "$asset_name" <<'NODE'
const fs = require('node:fs');
const [filename, release, assetName] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
if (value.tag_name !== release || value.draft || value.prerelease) {
  throw new Error(`Expected final llama.cpp release ${release}.`);
}
const asset = value.assets?.find(item => item.name === assetName);
if (!asset) throw new Error(`Release ${release} does not contain ${assetName}.`);
const expectedUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${release}/${assetName}`;
if (asset.browser_download_url !== expectedUrl) throw new Error('Unexpected llama.cpp asset URL.');
if (!/^sha256:[a-f0-9]{64}$/.test(String(asset.digest || ''))) {
  throw new Error('GitHub release metadata did not provide a valid SHA-256 asset digest.');
}
process.stdout.write(`${asset.browser_download_url}\n${asset.digest.slice(7)}\n`);
NODE
)
[[ "${#asset_metadata[@]}" -eq 2 ]] || fail 'could not resolve verified llama.cpp asset metadata'
asset_url="${asset_metadata[0]}"
asset_sha256="${asset_metadata[1]}"
archive="$temporary/$asset_name"

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --retry 3 --retry-all-errors "$asset_url" -o "$archive"
printf '%s  %s\n' "$asset_sha256" "$archive" | sha256sum --check --status \
  || fail 'llama.cpp archive digest did not match GitHub release metadata'

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail 'llama.cpp archive contains an unsafe path'
fi

staging="$temporary/runner"
mkdir -p "$staging"
tar -xzf "$archive" -C "$staging" --no-same-owner --no-same-permissions
staged_runner="$(find "$staging" -type f -name llama-cli -perm -u+x -print -quit)"
[[ -n "$staged_runner" ]] || fail 'verified llama.cpp archive did not contain an executable llama-cli'

install_root="$prefix/lib/archie/llama.cpp/${release}-${asset_arch}"
mkdir -p "$prefix/bin" "$(dirname "$install_root")"
rm -rf "${install_root}.new"
mv "$staging" "${install_root}.new"
rm -rf "$install_root"
mv "${install_root}.new" "$install_root"
relative_runner="${staged_runner#"$temporary/runner/"}"
installed_runner="$install_root/$relative_runner"
[[ -x "$installed_runner" ]] || fail 'llama-cli was not preserved during installation'

library_path="$(dirname "$installed_runner")"
while IFS= read -r library; do
  directory="$(dirname "$library")"
  case ":$library_path:" in
    *":$directory:"*) ;;
    *) library_path="$library_path:$directory" ;;
  esac
done < <(find "$install_root" -type f \( -name '*.so' -o -name '*.so.*' \) -print)

runner_wrapper="$prefix/bin/llama-cli"
if [[ -e "$runner_wrapper" ]] && ! grep -q '^# archie-managed-llama-cli$' "$runner_wrapper" 2>/dev/null; then
  [[ "${ARCHIE_LITE_REPLACE_RUNNER:-0}" == '1' ]] \
    || fail "$runner_wrapper already exists and is not Archie-managed; set ARCHIE_LITE_REPLACE_RUNNER=1 to replace it"
fi

wrapper_temporary="$temporary/llama-cli"
{
  printf '%s\n' '#!/usr/bin/env bash' '# archie-managed-llama-cli' 'set -euo pipefail'
  printf 'export LD_LIBRARY_PATH=%q:"${LD_LIBRARY_PATH:-}"\n' "$library_path"
  printf 'exec %q "$@"\n' "$installed_runner"
} > "$wrapper_temporary"
install -m 0755 "$wrapper_temporary" "$runner_wrapper"

archie_json="$temporary/archie-main.json"
curl_json "$archie_commit_api" "$archie_json"
archie_sha="$(node - "$archie_json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^[a-f0-9]{40}$/.test(String(value.sha || ''))) throw new Error('GitHub did not return an exact Archie main commit.');
process.stdout.write(value.sha);
NODE
)"
archie_source="https://github.com/Pokitomas/theawesomehexapp/archive/${archie_sha}.tar.gz"
npm install --global --prefix "$prefix" "$archie_source"

"$runner_wrapper" --version >/dev/null
"$prefix/bin/archie-lite" --help >/dev/null

receipt_directory="$prefix/share/archie/install-receipts"
receipt_path="$receipt_directory/archie-lite-linux-${archie_sha:0:12}-${release}.json"
mkdir -p "$receipt_directory"
RECEIPT_PATH="$receipt_path" \
ARCHIE_SHA="$archie_sha" \
LLAMA_RELEASE="$release" \
LLAMA_ASSET="$asset_name" \
LLAMA_ASSET_SHA256="$asset_sha256" \
RUNNER_PATH="$runner_wrapper" \
INSTALL_PREFIX="$prefix" \
node <<'NODE'
const fs = require('node:fs');
const receipt = {
  schema: 'archie-lite-linux-install-receipt/v1',
  platform: 'linux',
  architecture: process.arch,
  prefix: process.env.INSTALL_PREFIX,
  archie: {
    repository: 'Pokitomas/theawesomehexapp',
    commit: process.env.ARCHIE_SHA
  },
  runner: {
    repository: 'ggml-org/llama.cpp',
    release: process.env.LLAMA_RELEASE,
    asset: process.env.LLAMA_ASSET,
    sha256: process.env.LLAMA_ASSET_SHA256,
    command: process.env.RUNNER_PATH,
    backend: 'cpu'
  },
  model_downloaded: false,
  claim_boundary: 'The installer verified and installed the local runtime and CPU runner. It did not download model weights, train a model, prove capability, or admit a model.',
  created_at: new Date().toISOString()
};
fs.writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE

cat <<EOF
Archie Lite installed under:
  $prefix

Verified CPU runner:
  llama.cpp $release
  $asset_name
  sha256:$asset_sha256

Exact Archie revision:
  $archie_sha

Install receipt:
  $receipt_path

Add the user bin directory to PATH when needed:
  export PATH="$prefix/bin:\$PATH"

No model weights were downloaded. Admit a trusted signed GGUF model, then plan before running:
  archie pull /path/to/model-manifest.json --trust-key /path/to/publisher-public.pem
  archie-lite plan <id@version>
  archie-lite run <id@version> --prompt "Explain the current objective."
EOF
