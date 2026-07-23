param(
    [string]$Repo = (Get-Location).Path,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$linuxRepo = (wsl wslpath -a $Repo).Trim()
if (-not $linuxRepo) {
    throw "Could not map the repository path into WSL."
}

$dry = if ($DryRun) { "ARCHIE_BREAKTHROUGH_DRY_RUN=1 " } else { "" }
$escapedRepo = $linuxRepo.Replace("'", "'\''")
$command = "cd '$escapedRepo' && " +
    "git fetch origin agent/archie-world-state-core-20260722 && " +
    "git switch agent/archie-world-state-core-20260722 && " +
    "git pull --ff-only origin agent/archie-world-state-core-20260722 && " +
    "${dry}bash foundry/archie-distill/run_archie_breakthrough.sh"

wsl bash -lc $command
if ($LASTEXITCODE -ne 0) {
    throw "Archie breakthrough campaign exited with code $LASTEXITCODE."
}
