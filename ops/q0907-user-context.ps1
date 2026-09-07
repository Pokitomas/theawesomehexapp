param(
  [string]$Root = 'C:\actions-runner\q0907',
  [string]$TaskName = 'q0907-actions-runner-user'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Is-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = [Security.Principal.WindowsPrincipal]::new($id)
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Is-Admin)) { throw 'Run this from Administrator PowerShell.' }
if (-not (Test-Path (Join-Path $Root 'run.cmd'))) { throw "run.cmd missing under $Root" }

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "[q0907] switching persistent listener to interactive user context: $user"

# Prove the current user can actually see the intended WSL environment before changing persistence.
$wslProbe = & "$env:WINDIR\System32\wsl.exe" -e bash -lc 'printf "Q0907_WSL_USER_OK\n"; uname -a' 2>&1
$wslText = ($wslProbe | Out-String)
if ($wslText -notmatch 'Q0907_WSL_USER_OK') {
  Write-Host $wslText
  throw 'Current Windows user cannot reach the expected WSL distro; refusing to replace the working service listener.'
}
Write-Host ($wslText.Trim())

$service = Get-Service 'actions.runner.*' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*q0907-DESKTOP-6FN9B4M*' -or $_.DisplayName -like '*q0907-DESKTOP-6FN9B4M*' } |
  Select-Object -First 1

if ($service) {
  Write-Host "[q0907] stopping machine-account service $($service.Name)"
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $service.Name -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  Set-Service -Name $service.Name -StartupType Disabled
}

$supervisor = Join-Path $Root 'q0907-user-supervisor.ps1'
@"
`$ErrorActionPreference='Continue'
Set-Location '$($Root.Replace("'","''"))'
Remove-Item Env:RUNNER_TRACKING_ID -ErrorAction SilentlyContinue
while (`$true) {
  Add-Content -Path '.\q0907-user-supervisor.log' -Value "START user=`$env:USERNAME time=`$(Get-Date -Format o)"
  & cmd.exe /d /c run.cmd >> '.\q0907-user-runner.log' 2>&1
  `$code=`$LASTEXITCODE
  Add-Content -Path '.\q0907-user-supervisor.log' -Value "EXIT code=`$code time=`$(Get-Date -Format o)"
  Start-Sleep -Seconds 5
}
"@ | Set-Content -Encoding utf8 $supervisor

# Remove any stale copy of the user-context task before replacing it.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$ok = $false
for ($i=0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  $p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'Runner.Listener.exe' -and $_.ExecutablePath -like "$Root*"
  })
  if ($p.Count -gt 0) { $ok = $true; break }
}

if (-not $ok) {
  Get-Content (Join-Path $Root 'q0907-user-runner.log') -Tail 100 -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_ -notmatch '(?i)(token|credential|authorization)') { Write-Host $_ }
  }
  throw 'User-context Runner.Listener did not become observable.'
}

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Q0907_USER_CONTEXT_OK user=$env:USERNAME task=$($task.State) root=$Root"
