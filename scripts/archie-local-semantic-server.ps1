param(
  [string]$HostAddress = "172.22.64.1",
  [int]$Port = 18767,
  [int]$Context = 1024
)

$ErrorActionPreference = "Stop"
$Root = Join-Path $env:USERPROFILE ".archie\distill\qwen3-quality-local-v1"
$Exe = Join-Path $Root "llama-bin\vulkan\llama-server.exe"
$Model = Join-Path $Root "models\student-base-q8_0.gguf"
$StateDir = Join-Path $env:LOCALAPPDATA "ARCHIE"
$PidFile = Join-Path $StateDir "semantic-server.pid"
$Receipt = Join-Path $StateDir "semantic-server-receipt.json"
$Stdout = Join-Path $StateDir "semantic-server.out.log"
$Stderr = Join-Path $StateDir "semantic-server.err.log"

New-Item -ItemType Directory -Force $StateDir | Out-Null
if (-not (Test-Path $Exe)) { throw "llama-server missing: $Exe" }
if (-not (Test-Path $Model)) { throw "model missing: $Model" }

function Test-Health {
  try {
    $r = Invoke-RestMethod -Uri "http://${HostAddress}:${Port}/health" -TimeoutSec 1
    return $r.status -eq "ok"
  } catch { return $false }
}

if (Test-Health) {
  $p = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  [ordered]@{
    schema = "archie/local-semantic-server-receipt-v1"
    status = "already-live"
    time = (Get-Date).ToString("o")
    pid = $p.OwningProcess
    host = $HostAddress
    port = $Port
    context = $Context
    parallel_slots = 1
    model = $Model
  } | ConvertTo-Json | Set-Content -Encoding UTF8 $Receipt
  Get-Content $Receipt
  exit 0
}

# Kill only the process previously recorded by this launcher, and only if it is
# the expected llama-server executable. Never broad-kill Edge/Python/llama.
if (Test-Path $PidFile) {
  $oldPid = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if ($old -and $old.Path -eq $Exe) {
    Stop-Process -Id $oldPid -Force
    Start-Sleep -Milliseconds 300
  }
}

# Single foreground user => one slot. llama-server prompt caches are slot-local;
# using -np 1 prevents the same conversation prefix from randomly landing on a
# different slot and paying a cold prefill. cache_prompt remains enabled by
# default at request time; the broker also requests it explicitly.
$Arguments = @(
  "-m", $Model,
  "--host", $HostAddress,
  "--port", "$Port",
  "-c", "$Context",
  "-ngl", "99",
  "-np", "1",
  "--reasoning", "off",
  "--no-webui"
)

$p = Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden `
  -RedirectStandardError $Stderr -RedirectStandardOutput $Stdout -PassThru
Set-Content -Encoding ASCII $PidFile $p.Id

$deadline = (Get-Date).AddSeconds(45)
do {
  if ($p.HasExited) { throw "llama-server exited with $($p.ExitCode); see $Stderr" }
  if (Test-Health) { break }
  Start-Sleep -Milliseconds 150
} while ((Get-Date) -lt $deadline)
if (-not (Test-Health)) { throw "semantic server failed health court within 45 s" }

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
$process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
[ordered]@{
  schema = "archie/local-semantic-server-receipt-v1"
  status = "started"
  time = (Get-Date).ToString("o")
  pid = $process.Id
  executable = $process.Path
  host = $HostAddress
  port = $Port
  context = $Context
  parallel_slots = 1
  model = $Model
  model_bytes = (Get-Item $Model).Length
  health = "ok"
} | ConvertTo-Json | Set-Content -Encoding UTF8 $Receipt
Get-Content $Receipt
