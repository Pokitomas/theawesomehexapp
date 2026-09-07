param(
  [string]$Repo = 'Pokitomas/theawesomehexapp',
  [string]$StableRoot = '',
  [string]$RunnerName = "q0907-$env:COMPUTERNAME"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$s) { Write-Host "[q0907] $s" }
function Is-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = [Security.Principal.WindowsPrincipal]::new($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-GhToken([string]$Endpoint) {
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { return $null }
  try {
    $v = (& gh.exe api -X POST "repos/$Repo/actions/runners/$Endpoint" --jq .token 2>$null)
    if ($LASTEXITCODE -eq 0 -and $v) { return ($v | Select-Object -First 1).Trim() }
  } catch {}
  return $null
}
function Remove-LocalRunnerConfig([string]$Root) {
  foreach ($n in '.runner','.credentials','.credentials_rsaparams','.service') {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Root $n)
  }
}
function Install-UserSupervisor([string]$Root) {
  $supervisor = Join-Path $Root 'q0907-supervisor.ps1'
  @"
`$ErrorActionPreference='Continue'
Set-Location '$($Root.Replace("'","''"))'
Remove-Item Env:RUNNER_TRACKING_ID -ErrorAction SilentlyContinue
while (`$true) {
  Add-Content -Path '.\q0907-supervisor.log' -Value "START `$(Get-Date -Format o)"
  & cmd.exe /d /c run.cmd >> '.\q0907-runner.log' 2>&1
  `$code = `$LASTEXITCODE
  Add-Content -Path '.\q0907-supervisor.log' -Value "EXIT code=`$code time=`$(Get-Date -Format o)"
  Start-Sleep -Seconds 5
}
"@ | Set-Content -Encoding utf8 $supervisor

  $taskName = 'q0907-actions-runner'
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    return 'scheduled-task-supervisor'
  } catch {
    Say "scheduled-task setup failed: $($_.Exception.Message); using HKCU Run + detached supervisor"
    $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""
    New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'q0907-actions-runner' -Value $cmd
    Remove-Item Env:RUNNER_TRACKING_ID -ErrorAction SilentlyContinue
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$supervisor) -WindowStyle Hidden | Out-Null
    return 'hkcu-run-supervisor'
  }
}

$admin = Is-Admin
if ([string]::IsNullOrWhiteSpace($StableRoot)) {
  if ($admin) { $StableRoot = 'C:\actions-runner\q0907' }
  else { $StableRoot = "$env:USERPROFILE\.actions-runner\q0907" }
}

Say "target=$RunnerName root=$StableRoot elevated=$admin"
New-Item -ItemType Directory -Force -Path (Split-Path $StableRoot -Parent) | Out-Null

$source = $null
if (Test-Path (Join-Path $StableRoot 'config.cmd')) {
  $source = $StableRoot
} else {
  $candidates = @(
    Get-ChildItem "$env:LOCALAPPDATA\Temp" -Directory -Filter 'q0907-*' -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'config.cmd') -and Test-Path (Join-Path $_.FullName 'bin\Runner.Listener.exe') } |
      Sort-Object LastWriteTime -Descending
  )
  if ($candidates.Count -eq 0) {
    throw 'No q0907 runner installation tree found under the stable root or LOCALAPPDATA\Temp.'
  }
  $source = $candidates[0].FullName
  Say "recovering runner tree from $source"
  New-Item -ItemType Directory -Force -Path $StableRoot | Out-Null
  & robocopy.exe $source $StableRoot /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XD _work _diag | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -gt 7) { throw "robocopy failed rc=$rc" }
}

if (-not (Test-Path (Join-Path $StableRoot 'config.cmd'))) { throw 'Stable runner tree is incomplete: config.cmd missing.' }
if (-not (Test-Path (Join-Path $StableRoot 'run.cmd'))) { throw 'Stable runner tree is incomplete: run.cmd missing.' }

Push-Location $StableRoot
try {
  $registration = Get-GhToken 'registration-token'
  $registrationMode = $null
  $serviceRequested = $false

  if ($registration) {
    Say 'local GitHub authorization can mint a runner registration token; refreshing registration as non-ephemeral'
    if (Test-Path '.runner') {
      $remove = Get-GhToken 'remove-token'
      $removed = $false
      if ($remove) {
        try {
          & .\config.cmd remove --token $remove 2>&1 | ForEach-Object {
            $line = [string]$_
            if ($line -notmatch '(?i)token') { Write-Host $line }
          }
          if ($LASTEXITCODE -eq 0) { $removed = $true }
        } catch {}
      }
      if (-not $removed) {
        Say 'old registration could not be cleanly removed; discarding only local copied runner configuration files'
        Remove-LocalRunnerConfig $StableRoot
      }
      $remove = $null
    }

    $cfg = @('--unattended','--url',"https://github.com/$Repo",'--token',$registration,'--name',$RunnerName,'--work','_work','--replace')
    if ($admin) {
      $cfg += '--runasservice'
      $serviceRequested = $true
      Say 'configuring Windows service during runner registration'
    }

    & .\config.cmd @cfg 2>&1 | ForEach-Object {
      $line = [string]$_
      if ($line -notmatch '(?i)token') { Write-Host $line }
    }
    $configRc = $LASTEXITCODE
    $registration = $null
    if ($configRc -ne 0) { throw "config.cmd failed rc=$configRc" }
    $registrationMode = 'refreshed-non-ephemeral'
  } elseif (Test-Path '.runner') {
    Say 'no local registration-token authority; reusing recovered configured runner credentials under the same Windows machine'
    $registrationMode = 'reused-existing-config'
  } else {
    throw 'Runner registration is required, but local gh authorization cannot mint a registration token and no reusable .runner config exists.'
  }

  $persistence = $null
  if ($serviceRequested) {
    $svc = @(Get-Service 'actions.runner.*' -ErrorAction SilentlyContinue | Where-Object {
      $_.DisplayName -like "*$RunnerName*" -or $_.Name -like "*$RunnerName*"
    }) | Select-Object -First 1
    if ($svc) {
      if ($svc.Status -ne 'Running') { Start-Service -Name $svc.Name }
      $persistence = "windows-service:$($svc.Name)"
    } else {
      Say 'service was requested but no matching Actions service was found; falling back to a user supervisor'
      $persistence = Install-UserSupervisor $StableRoot
    }
  } else {
    $persistence = Install-UserSupervisor $StableRoot
  }

  $listener = $false
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      ($_.Name -match '^Runner\.(Listener|Worker)\.exe$') -and ($_.ExecutablePath -like "$StableRoot*")
    })
    if ($procs.Count -gt 0) { $listener = $true; break }
  }

  if (-not $listener) {
    Say 'listener not observed yet; diagnostic tails follow'
    Get-ChildItem '.\_diag\Runner_*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object {
      Get-Content $_.FullName -Tail 80 -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -notmatch '(?i)(token|credential|authorization)') { Write-Host $_ }
      }
    }
    Get-Content '.\q0907-runner.log' -Tail 80 -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_ -notmatch '(?i)(token|credential|authorization)') { Write-Host $_ }
    }
    throw 'Persistent q0907 listener did not become observable from the stable root.'
  }

  Write-Host "Q0907_REPAIR_OK root=$StableRoot registration=$registrationMode persistence=$persistence runner=$RunnerName"
} finally {
  Pop-Location
}
