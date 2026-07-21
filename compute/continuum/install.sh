#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
home_dir="${ARCHIE_CONTINUUM_HOME:-$HOME/archie-continuum}"
config="${ARCHIE_CONTINUUM_CONFIG:-$home_dir/config.json}"
mkdir -p "$home_dir"
if [[ ! -f "$config" ]]; then
  cp "$root/compute/continuum/config.example.json" "$config"
  python3 - "$config" "$home_dir" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
data["workspace"] = sys.argv[2]
data["repo_cache"] = str(pathlib.Path(sys.argv[2]) / "repo-cache")
path.write_text(json.dumps(data, indent=2) + "\n")
PY
fi
cat <<EOF
Installed configuration at $config

1. Set the same 32+ character secret locally and in GitHub repository secret ARCHIE_CONTINUUM_HMAC_KEY.
2. Edit node_id, poll.branch, tasks, and providers in $config.
3. Run:
   export ARCHIE_CONTINUUM_HMAC_KEY='...'
   python3 "$root/compute/continuum/continuum.py" doctor --config "$config"
   python3 "$root/compute/continuum/continuum.py" serve --config "$config"
EOF
