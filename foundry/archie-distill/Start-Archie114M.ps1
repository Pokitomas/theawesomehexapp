param(
    [switch]$DryRun
)

$Host.UI.RawUI.WindowTitle = "Archie 114M Training"
Clear-Host
Write-Host "ARCHIE 114M // MATRIX RUN" -ForegroundColor Green
Write-Host "Guarded, resumable, Sidepus-backed." -ForegroundColor Cyan

$localScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "archie-114m-next.sh"))
$drive = $localScript.Substring(0, 1).ToLowerInvariant()
$rest = $localScript.Substring(2).Replace('\', '/')
$wslScript = "/mnt/$drive$rest"

if ($DryRun) {
    wsl.exe env ARCHIE_DRY_RUN=1 bash "$wslScript"
} else {
    wsl.exe bash "$wslScript"
}

Write-Host "`nRun returned. Read the receipt before believing the sample." -ForegroundColor Magenta
