[CmdletBinding()]
param(
    [string]$CandidateDir = 'returns\generative-git-experience-promoted',
    [double]$MaximumRetentionRegression = 0.02,
    [double]$MinimumPlasticEffect = 0.03,
    [switch]$Validate
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$CandidateRoot = if ([System.IO.Path]::IsPathRooted($CandidateDir)) {
    [System.IO.Path]::GetFullPath($CandidateDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $Repo $CandidateDir))
}
if (-not $CandidateRoot.StartsWith($Repo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Candidate directory must remain inside the repository: $CandidateRoot"
}
$Promoted = Join-Path $CandidateRoot 'archie-git-experience.pt'
$Receipt = Join-Path $CandidateRoot 'merge-receipt.json'
$Retention = Join-Path $CandidateRoot 'public-retention.json'
$Plasticity = Join-Path $CandidateRoot 'plastic-transfer.json'

Write-Host 'Archie campaign survival check'
Write-Host "  repository: $Repo"
Write-Host "  candidate: $CandidateRoot"
$active = wsl -e bash -lc "pgrep -af '([t]rain_archie_git_experience.py|[s]earch_archie_causal_merge.py)' || true"
if ($active) {
    Write-Host '  active Linux work:'
    $active | ForEach-Object { Write-Host "    $_" }
} else {
    Write-Host '  active Linux work: none'
}

if (-not (Test-Path -LiteralPath $Promoted) -or -not (Test-Path -LiteralPath $Receipt) -or -not (Test-Path -LiteralPath $Retention) -or -not (Test-Path -LiteralPath $Plasticity)) {
    throw 'Promoted model or merge receipt is missing. Preserve the WSL run directories before starting another campaign.'
}
$merge = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
$retention = Get-Content -LiteralPath $Retention -Raw | ConvertFrom-Json
$plasticity = Get-Content -LiteralPath $Plasticity -Raw | ConvertFrom-Json
$expectedHash = [string]$merge.models.selected.sha256
$actualHash = (Get-FileHash -LiteralPath $Promoted -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
    throw "Candidate model hash mismatch: $actualHash"
}

Write-Host '  task-candidate model: intact'
Write-Host "  SHA-256: $actualHash"
Write-Host "  alpha: $($merge.models.selected.alpha)"
Write-Host "  final patch gain: $($merge.final_temporal_holdout.chosen_nats_gain) nats/token"
Write-Host "  final causal gain: $($merge.final_temporal_holdout.causal_advantage_gain)"
Write-Host "  final pair gain: $($merge.final_temporal_holdout.pair_accuracy_gain)"
$taskPass = (
    [double]$merge.final_temporal_holdout.chosen_nats_gain -gt 0 -and
    [double]$merge.final_temporal_holdout.causal_advantage_gain -gt 0 -and
    [double]$merge.final_temporal_holdout.pair_accuracy_gain -gt 0
)
$retentionEffect = [double]$retention.models[-1].metrics.relative_bits_per_byte_gain_vs_first
$retentionPass = $retentionEffect -ge -$MaximumRetentionRegression
$plasticityEffect = [double]$plasticity.metrics.mean_relative_effect
$plasticityPass = $plasticityEffect -ge $MinimumPlasticEffect -and [double]$plasticity.metrics.improved_fraction -ge 0.6
Write-Host "  repository-transition gate: $taskPass"
Write-Host "  public-retention effect: $retentionEffect"
Write-Host "  public-retention gate: $retentionPass"
Write-Host "  plasticity effect: $plasticityEffect"
Write-Host "  plasticity gate: $plasticityPass"

if ($taskPass -and $retentionPass -and $plasticityPass) {
    Write-Host '  decision: research candidate clears current gates'
} elseif ($taskPass -and -not $retentionPass) {
    Write-Host '  decision: task specialist only; general promotion blocked'
    Write-Host '  next move: retention-aware task-vector merge against the public model; do not retrain yet'
} elseif (-not $taskPass) {
    Write-Host '  decision: reject repository specialist; redesign observation or credit assignment'
} else {
    Write-Host '  decision: slow weights retained; fast plasticity remains unadmitted'
}

if ($Validate) {
    Push-Location $Repo
    try {
        python foundry/archie-distill/compile_git_experience.py --selftest
        wsl -e bash -lc "cd /home/awesomekai/archie-repo && /home/awesomekai/.venv-archie-cuda/bin/python foundry/archie-distill/train_archie_git_experience.py --selftest"
        wsl -e bash -n /home/awesomekai/archie-repo/foundry/archie-distill/run_archie_git_experience.sh
        git diff --check
    } finally {
        Pop-Location
    }
}

Write-Host 'Campaign is recoverable. Do not retrain merely because the terminal closed.'
