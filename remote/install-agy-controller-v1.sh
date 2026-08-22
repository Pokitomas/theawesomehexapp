#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/awesomekai/archie-remote/agy-extension
PY="$ROOT/agy_controller_v1.py"
UNIT=/home/awesomekai/.config/systemd/user/archie-agy-controller-court.service
mkdir -p "$ROOT" /home/awesomekai/.config/systemd/user
curl -fsSL --max-time 30 \
  https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/remote/agy_controller_v1.py \
  -o "$PY.tmp"
python3 -m py_compile "$PY.tmp"
mv "$PY.tmp" "$PY"
chmod 0755 "$PY"
cat > "$UNIT" <<EOF
[Unit]
Description=ARCHIE Antigravity capability court and persistent broker installer
After=default.target network-online.target archie-shell-sidecar.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $PY
Restart=no
Nice=5
CPUWeight=30
OOMScoreAdjust=150
Environment=PYTHONUNBUFFERED=1
StandardOutput=append:$ROOT/controller.log
StandardError=append:$ROOT/controller.log
EOF
systemctl --user daemon-reload
systemctl --user reset-failed archie-agy-controller-court.service 2>/dev/null || true
systemctl --user start archie-agy-controller-court.service
printf 'AGY_CONTROLLER_ADMITTED\n'
systemctl --user show archie-agy-controller-court.service -p ActiveState -p SubState -p MainPID --no-pager
printf 'report=%s\n' "$ROOT/agy-capability-report.json"
printf 'events=%s\n' "$ROOT/events.jsonl"
printf 'log=%s\n' "$ROOT/controller.log"
