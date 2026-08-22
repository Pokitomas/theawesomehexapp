#!/usr/bin/env bash
set -uo pipefail

ROOT=/home/awesomekai/archie-remote
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN="$ROOT/agy-extension-$STAMP"
mkdir -p "$RUN"
exec > >(tee "$RUN/controller.log") 2>&1

echo AGY_EXTENSION_CONTROLLER_V3
echo "time=$(date --iso-8601=seconds)"
echo "host=$(hostname)"
echo "run=$RUN"

for u in archie-shell-sidecar.service archie-gpt56-unblock.service hotwire.service hotwire-sentinel.service hotwire-deck.service hotwire-tot.service hotwire-trainer.service archie-executed-patch-semidir-57m-s47.service; do
  printf '%s=' "$u"; systemctl --user is-active "$u" 2>/dev/null || true
done

pgrep -af '[a]gy' || true
AGY=$(command -v agy 2>/dev/null || true)
echo "agy_path=$AGY"
[ -n "$AGY" ] || { echo FATAL=no_agy_on_PATH; exit 23; }
readlink -f "$AGY" 2>/dev/null || true
"$AGY" --version 2>&1 | tee "$RUN/version.txt" || true
timeout 20s "$AGY" --help >"$RUN/help.txt" 2>&1 || true
timeout 20s "$AGY" models >"$RUN/models.txt" 2>&1 || true
timeout 20s "$AGY" agents >"$RUN/agents.txt" 2>&1 || true

# Safe read-only/introspection slash commands. Mutating commands are inventoried via /help but not invoked.
for cmd in /help /permissions /hooks /config /usage /quota /credits /model /effort /skills /agents /tasks /mcp /context; do
  slug=$(printf '%s' "$cmd" | tr -cd 'A-Za-z0-9_-')
  timeout 35s "$AGY" -p "$cmd" --output-format text --print-timeout 25s >"$RUN/slash-${slug}.out" 2>"$RUN/slash-${slug}.err"
  rc=$?
  printf '%s rc=%s out=%s err=%s\n' "$cmd" "$rc" "$(wc -c <"$RUN/slash-${slug}.out")" "$(wc -c <"$RUN/slash-${slug}.err")"
done

PROBE_FILE="$RUN/input-reference.txt"
printf 'REFERENCE_TOKEN=AGY_AT_FILE_PROBE_OK\n' > "$PROBE_FILE"

timeout 50s "$AGY" -p 'Reply with exactly AGY_PLAIN_PROBE_OK.' --effort low --output-format stream-json --print-timeout 35s >"$RUN/probe-plain.ndjson" 2>"$RUN/probe-plain.err" || true

timeout 60s "$AGY" -p "Read @$PROBE_FILE and reply with only the value after REFERENCE_TOKEN=." --effort low --output-format stream-json --print-timeout 45s >"$RUN/probe-atfile.ndjson" 2>"$RUN/probe-atfile.err" || true

timeout 45s "$AGY" -p '!printf AGY_BANG_PROBE_OK' --output-format stream-json --print-timeout 30s >"$RUN/probe-bang.ndjson" 2>"$RUN/probe-bang.err" || true

MULTI=$'Line one is noise.\nLine two instruction: reply exactly AGY_MULTILINE_PROBE_OK.\nIgnore line one.'
timeout 50s "$AGY" -p "$MULTI" --effort low --output-format stream-json --print-timeout 35s >"$RUN/probe-multiline.ndjson" 2>"$RUN/probe-multiline.err" || true

SCHEMA='{"type":"object","properties":{"token":{"type":"string"},"n":{"type":"integer"}},"required":["token","n"],"additionalProperties":false}'
timeout 60s "$AGY" -p 'Return token AGY_SCHEMA_PROBE_OK and integer n=7.' --effort low --output-format stream-json --json-schema "$SCHEMA" --print-timeout 45s >"$RUN/probe-schema.ndjson" 2>"$RUN/probe-schema.err" || true

timeout 90s "$AGY" -p "Use your shell/tool system to create $RUN/agent-shell-proof.txt containing exactly AGY_AGENT_SHELL_PROBE_OK, then read it back and reply exactly AGY_AGENT_SHELL_PROBE_OK." --effort medium --output-format stream-json --dangerously-skip-permissions --print-timeout 75s >"$RUN/probe-agent-shell.ndjson" 2>"$RUN/probe-agent-shell.err" || true

python3 - "$RUN" > "$RUN/capability-summary.txt" <<'PY'
import json, pathlib, sys
run=pathlib.Path(sys.argv[1])
for p in sorted(run.glob('probe-*.ndjson')):
    tools=[]; subs=[]; text=[]; statuses=[]
    for raw in p.read_text(errors='replace').splitlines():
        try: o=json.loads(raw, strict=False)
        except Exception: continue
        ev=o.get('event')
        if ev=='init':
            d=o.get('init') or o; tools += list(d.get('tools') or [])
        elif ev=='step_update':
            d=o.get('step_update') or {}
            if d.get('tool_name'): tools.append(d['tool_name'])
            if d.get('text_delta'): text.append(d['text_delta'])
            if d.get('subagent_info'): subs.append(d['subagent_info'])
        elif ev=='result':
            d=o.get('result') or {}
            if d.get('status'): statuses.append(d['status'])
            if d.get('response'): text.append(str(d['response']))
    print(p.name, 'status='+','.join(statuses), 'tools='+','.join(dict.fromkeys(map(str,tools))), 'subagents='+str(len(subs)), 'text='+repr(''.join(text)[-500:]))
PY
cat "$RUN/capability-summary.txt"

TASK=$(cat <<EOF
You are an execution extension for GPT-5.6 Sol on the owner-authorized local workstation.

Hard constraints:
- Preserve every existing GPU trainer exactly as-is: do not stop, restart, renice, reconfigure, signal, update, install around, or otherwise perturb any trainer or CUDA owner.
- Do not modify the DaVinci Resolve project, timeline, media, or settings. DaVinci inspection is READ-ONLY.
- Do not delete user data, alter credentials, log out accounts, change networking, or weaken security.
- You may run read-only shell/process/service queries, read project/config/source files, inspect the Windows desktop through already-installed local controller/Hotwire modalities, use code/file search, and delegate to subagents.
- You may write only report/proof files under $ROOT and scratch files under $RUN.

Mission:
1. Inspect the tools/modalities you ACTUALLY have in this run; use tool/event evidence, not guesses.
2. Exercise as many distinct safe modalities as genuinely available: local shell, file read/search, Windows process/query bridge, Hotwire/desktop observation, and parallel subagents. Record absent modalities as failures.
3. Inspect live ARCHIE control with emphasis on archie-shell-sidecar.service, archie-gpt56-unblock.service, hotwire.service, hotwire-sentinel.service, hotwire-deck.service. Determine exact executable paths, listeners/ports, and which path can perform full-computer observation/action versus text-only transport. Do not restart anything.
4. Inspect the running Antigravity/agy process/session enough to distinguish CLI capabilities from desktop-app capabilities without disturbing the interactive session.
5. Inspect current DaVinci Resolve state READ-ONLY: process/window/project/timeline names if available, current page/panel, and safe observable state. Make no edits.
6. Delegate at least two independent subagents if supported: one maps controller/Hotwire, one maps DaVinci/desktop. Reconcile their evidence.
7. Judge your operational intelligence empirically from successes: instruction following, shell use, file grounding, desktop grounding, subagent orchestration, recovery from failed tools. Score each 0-5 and cite evidence.
8. Write $ROOT/AGY_EXTENSION_REPORT.json as valid JSON with keys generated_at, agy_version, modalities_available, modalities_used, tools_seen, subagents_used, controller_paths, listeners, desktop_control_findings, davinci_state, capability_scores, evidence, failures, contradictions, next_best_action.
9. Write $ROOT/AGY_EXTENSION_PROOF.txt beginning with AGY_EXTENSION_DONE followed by concise evidence paths.
10. End your response with AGY_EXTENSION_DONE.

Do the work; do not merely describe a plan.
EOF
)

timeout 10m "$AGY" -p "$TASK" --effort high --output-format stream-json --dangerously-skip-permissions --print-timeout 9m >"$RUN/extension.ndjson" 2>"$RUN/extension.err"
EXT_RC=$?
echo "extension_rc=$EXT_RC"

python3 - "$RUN" "$ROOT" > "$RUN/extension-observer.txt" <<'PY'
import json, pathlib, sys
run=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2]); p=run/'extension.ndjson'
tools=[]; subs=[]; status=[]; final=[]
if p.exists():
  for raw in p.read_text(errors='replace').splitlines():
    try:o=json.loads(raw, strict=False)
    except Exception:continue
    ev=o.get('event')
    if ev=='init':
      d=o.get('init') or o; tools += list(d.get('tools') or [])
    elif ev=='step_update':
      d=o.get('step_update') or {}
      if d.get('tool_name'): tools.append(d['tool_name'])
      if d.get('subagent_info'): subs.append(d['subagent_info'])
      if d.get('text_delta'): final.append(d['text_delta'])
    elif ev=='result':
      d=o.get('result') or {}
      if d.get('status'): status.append(d['status'])
      if d.get('response'): final.append(str(d['response']))
print('stream_status='+','.join(status))
print('tools='+','.join(dict.fromkeys(map(str,tools))))
print('subagent_events='+str(len(subs)))
print('final_has_done='+str('AGY_EXTENSION_DONE' in ''.join(final)))
for name in ['AGY_EXTENSION_REPORT.json','AGY_EXTENSION_PROOF.txt']:
  q=root/name
  print(f'{name}: exists={q.exists()} bytes={q.stat().st_size if q.exists() else 0}')
  if q.exists(): print(q.read_text(errors='replace')[:12000])
PY
cat "$RUN/extension-observer.txt"
cp "$RUN/capability-summary.txt" "$ROOT/AGY_CAPABILITY_SUMMARY.txt"
printf '%s\n' "$RUN" > "$ROOT/AGY_EXTENSION_LATEST_PATH.txt"

for u in archie-shell-sidecar.service archie-gpt56-unblock.service hotwire.service hotwire-sentinel.service hotwire-deck.service hotwire-trainer.service archie-executed-patch-semidir-57m-s47.service; do
  printf '%s=' "$u"; systemctl --user is-active "$u" 2>/dev/null || true
done

echo "run=$RUN"
echo "report=$ROOT/AGY_EXTENSION_REPORT.json"
echo "proof=$ROOT/AGY_EXTENSION_PROOF.txt"
