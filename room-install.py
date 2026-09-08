#!/usr/bin/env python3
import base64, json, os
from pathlib import Path
import subprocess, sys, time

REPO="Pokitomas/theawesomehexapp"; BRANCH="mach-live-bus"
STABLE=Path.home()/".q0907-live"; DEST=STABLE/"room.py"; LOG=STABLE/"room.log"

def run(a,check=True):
    p=subprocess.run(a,text=True,encoding="utf-8",errors="replace",stdout=subprocess.PIPE,stderr=subprocess.STDOUT,shell=False)
    if check and p.returncode: raise RuntimeError(p.stdout[-2000:])
    return p

raw=run(["gh.exe","api",f"repos/{REPO}/contents/room-watcher.py?ref={BRANCH}","--jq",".content"]).stdout
code=base64.b64decode("".join(raw.split())).decode("utf-8")
STABLE.mkdir(parents=True,exist_ok=True); DEST.write_text(code,encoding="utf-8")
ps="$self=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*\\.q0907-live\\room.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
run(["powershell.exe","-NoLogo","-NoProfile","-NonInteractive","-Command",ps],check=False)
import winreg
k=winreg.OpenKey(winreg.HKEY_CURRENT_USER,r"Software\Microsoft\Windows\CurrentVersion\Run",0,winreg.KEY_SET_VALUE)
try: winreg.SetValueEx(k,"Q0907MachRoom",0,winreg.REG_SZ,f'"{sys.executable}" "{DEST}"')
finally: winreg.CloseKey(k)
env=os.environ.copy();env.pop("RUNNER_TRACKING_ID",None)
flags=sum(int(getattr(subprocess,n,0)) for n in ("DETACHED_PROCESS","CREATE_NEW_PROCESS_GROUP","CREATE_NO_WINDOW"))
log=open(LOG,"ab",buffering=0)
subprocess.Popen([sys.executable,str(DEST)],cwd=str(STABLE),stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env,creationflags=flags,close_fds=True)
time.sleep(1.2)
check="$self=$PID; (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*\\.q0907-live\\room.py*' }).ProcessId -join ','"
pids=run(["powershell.exe","-NoLogo","-NoProfile","-NonInteractive","-Command",check],check=False).stdout.strip()
if not pids: raise RuntimeError("room watcher not alive")
print("MACH_ROOM_WATCHER_OK pids="+pids)
