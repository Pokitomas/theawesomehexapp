#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$AuditOnly
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$UserRoot = 'C:\Users\AwesomeKai'
$ProjectRoot = Join-Path $UserRoot 'Documents\New project'
$EvidenceReceipt = Join-Path $ProjectRoot 'PC_NANNY_RECEIPT.md'
$Receipt = Join-Path $ProjectRoot 'PC_NANNY_SPRING_CLEAN_20260819_RECEIPT.md'
$WallRoot = Join-Path $UserRoot 'Pictures\2011 Meme Rotation'
$WallSrc = Join-Path $WallRoot 'sources'
$Started = Get-Date
$BeforeFree = (Get-PSDrive C -ErrorAction SilentlyContinue).Free
$FreedEstimate = [int64]0
$RemovedCount = 0
$Failed = New-Object System.Collections.Generic.List[string]
$Actions = New-Object System.Collections.Generic.List[string]
$Protected = @(
    'PWA', 'release', 'Q4', 'Q6', 'Archie', 'ACSC', 'V13',
    'checkpoint', 'model', 'weights', 'corpus', 'receipts'
)

function Add-Action([string]$Text) { $script:Actions.Add($Text) | Out-Null; Write-Host $Text }
function Add-Failure([string]$Text) { $script:Failed.Add($Text) | Out-Null; Write-Warning $Text }
function Is-ProtectedPath([string]$Path) {
    if (-not $Path) { return $false }
    foreach ($p in $Protected) { if ($Path -match [regex]::Escape($p)) { return $true } }
    return $false
}
function Get-TreeBytes([string]$Path) {
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return [int64](Get-Item -LiteralPath $Path -Force).Length }
        return [int64]((Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)
    } catch { return 0 }
}
function Remove-RebuildablePath([string]$Path, [string]$Reason) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Is-ProtectedPath $Path) { Add-Action "PROTECTED_SKIP $Path"; return }
    $bytes = Get-TreeBytes $Path
    if ($AuditOnly) { Add-Action "AUDIT_WOULD_REMOVE $Reason bytes=$bytes path=$Path"; return }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        $script:FreedEstimate += $bytes; $script:RemovedCount++
        Add-Action "REMOVED $Reason bytes=$bytes path=$Path"
    } catch { Add-Failure "REMOVE_FAIL $Reason path=$Path :: $($_.Exception.Message)" }
}
function Remove-OldChildren([string]$Root, [datetime]$Cutoff, [string]$Reason) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $Cutoff } | ForEach-Object {
        Remove-RebuildablePath $_.FullName $Reason
    }
}
function Invoke-Quiet([scriptblock]$Script, [string]$Label) {
    try { & $Script 2>&1 | ForEach-Object { Write-Host $_ } } catch { Add-Failure "$Label :: $($_.Exception.Message)" }
}

New-Item -ItemType Directory -Force -Path $ProjectRoot,$WallRoot,$WallSrc | Out-Null
$TmpTranscript = Join-Path $env:TEMP ("pc-nanny-{0}.txt" -f [guid]::NewGuid())
Start-Transcript -Path $TmpTranscript -Force | Out-Null

Write-Host '# PC NANNY SPRING CLEAN — 2026-08-19'
Write-Host "started: $($Started.ToString('o'))"
Write-Host "audit_only: $AuditOnly"
Write-Host "computer: $env:COMPUTERNAME"
Write-Host "user: $env:USERNAME"
Write-Host ''
Write-Host '## Hard fences'
Write-Host '- Preserve 2.50 GB PWA release ZIP; duplicate payload is known but bundle value remains.'
Write-Host '- Preserve checked Archie and ACSC model runs; they are distinct.'
Write-Host '- Preserve Q4/Q6 repair models, weights, checkpoints, corpora and durable receipts.'
Write-Host '- V13 Unicode filename anomaly is audit-only; no wildcard rename/delete.'
Write-Host '- No generic python/node/WSL process killing.'
Write-Host ''

Write-Host '## Existing evidence inventory'
if (Test-Path -LiteralPath $EvidenceReceipt) {
    Write-Host "receipt=$EvidenceReceipt bytes=$((Get-Item -LiteralPath $EvidenceReceipt).Length)"
    Get-Content -LiteralPath $EvidenceReceipt -TotalCount 500 -ErrorAction SilentlyContinue
} else { Write-Host 'PC_NANNY_RECEIPT.md MISSING' }
Write-Host ''

Write-Host '## GPU / processes before'
Invoke-Quiet { & nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader } 'nvidia-smi gpu'
Invoke-Quiet { & nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader } 'nvidia-smi apps'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{Id=$_.ProcessId;Name=$_.Name;MB=[math]::Round(($p.WorkingSet64/1MB),1);CommandLine=$_.CommandLine}
} | Sort-Object MB -Descending | Select-Object -First 100 | Format-Table -Wrap -AutoSize
Write-Host ''

Write-Host '## Startup / scheduled task inventory'
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue | Format-List
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -match 'Archie|Claude|Codex|AI|wall|meme|python|node|WSL|Tailscale|Resolve'
} | ForEach-Object {
    [pscustomobject]@{Task=$_.TaskName;Path=$_.TaskPath;State=$_.State;Actions=(($_.Actions|ForEach-Object{"$($_.Execute) $($_.Arguments)"}) -join ' | ')}
} | Format-Table -Wrap -AutoSize
Write-Host ''

# ---- Windows rebuildable junk ----
Write-Host '## Windows rebuildable cleanup'
$Cut7 = (Get-Date).AddDays(-7)
$Cut3 = (Get-Date).AddDays(-3)
Remove-OldChildren $env:TEMP $Cut7 'windows-temp-old'
Remove-OldChildren (Join-Path $env:LOCALAPPDATA 'Temp') $Cut7 'local-temp-old'
Remove-OldChildren (Join-Path $env:LOCALAPPDATA 'CrashDumps') $Cut3 'crash-dump-old'
Remove-OldChildren (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive') $Cut7 'wer-archive-old'
Remove-OldChildren (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue') $Cut7 'wer-queue-old'

$CacheRoots = @(
    (Join-Path $env:LOCALAPPDATA 'pip\Cache'),
    (Join-Path $env:LOCALAPPDATA 'npm-cache\_cacache'),
    (Join-Path $env:LOCALAPPDATA 'D3DSCache'),
    (Join-Path $env:LOCALAPPDATA 'NVIDIA\DXCache'),
    (Join-Path $env:LOCALAPPDATA 'NVIDIA\GLCache'),
    (Join-Path $env:LOCALAPPDATA 'NVIDIA Corporation\NV_Cache'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default\Cache'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default\Code Cache'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default\Cache'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default\Code Cache')
)
foreach ($p in $CacheRoots) { Remove-RebuildablePath $p 'rebuildable-cache' }

# ---- Project-local cache dirs only ----
Write-Host ''
Write-Host '## Project build/cache directories'
$CacheNames = @('__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.next\cache','node_modules\.cache')
foreach ($root in @($ProjectRoot, (Join-Path $UserRoot 'Documents'), (Join-Path $UserRoot 'Desktop'))) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        $full=$_.FullName
        ($_.Name -in @('__pycache__','.pytest_cache','.mypy_cache','.ruff_cache')) -or $full -match '\\.next\\cache$' -or $full -match '\\node_modules\\\.cache$'
    } | ForEach-Object { Remove-RebuildablePath $_.FullName 'project-cache-dir' }
}

# ---- WSL cleanup / service census ----
Write-Host ''
Write-Host '## WSL / ARCHIE service census and rebuildable caches'
$WslScript = @'
set -u
printf '%s\n' '--- running user services ---'
systemctl --user --no-pager --type=service --state=running 2>/dev/null | grep -Ei 'archie|sidecar|agent|worker|trainer|gpu|claude|codex' || true
printf '%s\n' '--- exact protected/control services ---'
for u in archie-shell-sidecar.service archie-agent-worker.service archie-live-exec.service archie-chatgpt-takeover.service archie-codex-bridge.service archie-control-plane-watchdog.timer; do printf '%s=' "$u"; systemctl --user is-active "$u" 2>/dev/null || true; done
printf '%s\n' '--- top processes ---'
ps -eo pid,ppid,etimes,%cpu,%mem,rss,stat,args --sort=-rss | head -n 100 || true
printf '%s\n' '--- rebuildable caches ---'
find /home/awesomekai -xdev -type d \( -name __pycache__ -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache -o -path '*/node_modules/.cache' -o -path '*/.next/cache' \) -print0 2>/dev/null | while IFS= read -r -d '' d; do
  case "$d" in *checkpoint*|*model*|*weights*|*corpus*|*receipt*|*V13*|*ACSC*|*Archie*) echo "PROTECTED_SKIP $d";; *) if [ "${AUDIT_ONLY:-0}" = 1 ]; then echo "AUDIT_WOULD_REMOVE $d"; else du -sh "$d" 2>/dev/null || true; rm -rf -- "$d" 2>/dev/null && echo "REMOVED $d" || true; fi;; esac
done
if [ "${AUDIT_ONLY:-0}" != 1 ]; then
  python3 -m pip cache purge 2>/dev/null || true
  npm cache clean --force 2>/dev/null || true
fi
printf '%s\n' '--- exact legacy presentation services ---'
for u in archie-takeover-instrument.service archie-unified-atlas.service archie-surface.service archie-dashboard-truth.service; do
  if systemctl --user is-active --quiet "$u" 2>/dev/null; then
    if [ "${AUDIT_ONLY:-0}" = 1 ]; then echo "AUDIT_WOULD_STOP $u"; else systemctl --user stop "$u" && echo "STOPPED_LEGACY_PRESENTATION $u" || true; fi
  fi
done
'@
$env:AUDIT_ONLY = if($AuditOnly){'1'}else{'0'}
try { $WslScript | wsl.exe -e bash -s 2>&1 | ForEach-Object { Write-Host $_ } } catch { Add-Failure "WSL_PASS :: $($_.Exception.Message)" }
Remove-Item Env:AUDIT_ONLY -ErrorAction SilentlyContinue

# ---- Large files and exact duplicates: inventory only ----
Write-Host ''
Write-Host '## Large files (inventory only)'
$ScanRoots = @($ProjectRoot, (Join-Path $UserRoot 'Downloads')) | Where-Object { Test-Path -LiteralPath $_ }
$Large = foreach ($root in $ScanRoots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -ge 64MB }
}
$Large | Sort-Object Length -Descending | Select-Object -First 250 @{n='GB';e={[math]::Round($_.Length/1GB,3)}},FullName,LastWriteTime | Format-Table -Wrap -AutoSize
Write-Host ''
Write-Host '## Exact duplicate groups >=64 MB (inventory only; no deletion)'
$DupGroups = New-Object System.Collections.Generic.List[object]
$Large | Group-Object Length | Where-Object Count -gt 1 | ForEach-Object {
    $_.Group | ForEach-Object {
        try { [pscustomobject]@{Path=$_.FullName;Length=$_.Length;Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash} } catch {}
    } | Group-Object Hash | Where-Object Count -gt 1 | ForEach-Object {
        $g=$_.Group
        $obj=[pscustomobject]@{Bytes=$g[0].Length;SHA256=$_.Name;Paths=($g.Path -join ' || ')}
        $DupGroups.Add($obj) | Out-Null; $obj
    }
} | Format-Table -Wrap -AutoSize
Write-Host "duplicate_groups=$($DupGroups.Count)"

# ---- V13 Unicode anomaly: audit only ----
Write-Host ''
Write-Host '## V13 Unicode filename anomaly — audit only'
if (Test-Path -LiteralPath $EvidenceReceipt) {
    Select-String -LiteralPath $EvidenceReceipt -Pattern 'V13|unicode|filename|delete|replace' -CaseSensitive:$false -ErrorAction SilentlyContinue | Select-Object -First 150 | ForEach-Object { $_.Line }
}
Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName -match 'V13' -and $_.Name -match '[^\x00-\x7F]'
} | Select-Object FullName,Length,LastWriteTime | Format-Table -Wrap -AutoSize
Write-Host 'V13_MUTATION=NONE'

# ---- Replace weird AI wallpaper loop with classic web meme rotation ----
Write-Host ''
Write-Host '## 2011-ish classic meme wallpaper rotation'
$Sources = [ordered]@{
    'success'   = 'https://imgflip.com/s/meme/Success-Kid.jpg'
    'scumbag'   = 'https://imgflip.com/s/meme/Scumbag-Steve.jpg'
    'philo'     = 'https://imgflip.com/s/meme/Philosoraptor.jpg'
    'troll'     = 'https://imgflip.com/s/meme/Troll-Face.jpg'
    'badluck'   = 'https://imgflip.com/s/meme/Bad-Luck-Brian.jpg'
    'fry'       = 'https://imgflip.com/s/meme/Futurama-Fry.jpg'
    'aliens'    = 'https://imgflip.com/s/meme/Ancient-Aliens.jpg'
    'boromir'   = 'https://imgflip.com/s/meme/One-Does-Not-Simply.jpg'
    'nyan'      = 'https://i.imgflip.com/atevl.jpg'
}
@('Classic web meme source images fetched by the PC nanny on 2026-08-19.') + ($Sources.GetEnumerator() | ForEach-Object { "$($_.Key) = $($_.Value)" }) + 'Captions/layout are custom; source images remain credited by URL.' | Set-Content -LiteralPath (Join-Path $WallRoot 'SOURCES.txt') -Encoding UTF8
foreach ($kv in $Sources.GetEnumerator()) {
    $out = Join-Path $WallSrc ($kv.Key + '.jpg')
    if ($AuditOnly) { Add-Action "AUDIT_WOULD_DOWNLOAD $($kv.Value) -> $out"; continue }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $kv.Value -OutFile $out -TimeoutSec 40
        Add-Action "MEME_SOURCE $($kv.Key) $out"
    } catch { Add-Failure "MEME_DOWNLOAD_FAIL $($kv.Key) :: $($_.Exception.Message)" }
}

if (-not $AuditOnly) {
    try {
        Add-Type -AssemblyName System.Drawing
        $Items = @(
            @{s='success.jpg';a='CLEANED TEMP';b='DIDN''T DELETE THE MODEL'},
            @{s='scumbag.jpg';a='SAYS "RELEASE ZIP"';b='CONTAINS THE SAME 2.5 GB'},
            @{s='philo.jpg';a='IF CACHE IS REBUILDABLE';b='WHY IS IT 47 GB'},
            @{s='troll.jpg';a='RUNS ONE MORE SIDECAR';b='47 PORTS LATER'},
            @{s='badluck.jpg';a='DELETES ONE DUPLICATE';b='IT WAS THE CANONICAL COPY'},
            @{s='fry.jpg';a='NOT SURE IF BACKUP';b='OR SECOND PROBLEM'},
            @{s='aliens.jpg';a='DUPLICATE FILES?';b='AGENTS'},
            @{s='boromir.jpg';a='ONE DOES NOT SIMPLY';b='RM -RF ARCHIE'},
            @{s='nyan.jpg';a='GPU AT 0%';b='STILL HEATING THE ROOM'},
            @{s='success.jpg';a='HASHED BOTH RUNS';b='THEY''RE ACTUALLY DIFFERENT'},
            @{s='philo.jpg';a='IS IT A CHECKPOINT';b='IF NOBODY KNOWS WHAT RESUMES IT'},
            @{s='scumbag.jpg';a='MAKES A TEMP DIR';b='CALLS IT PERMANENT'}
        )
        function Draw-MemeText($g,[string]$text,[float]$y,$font) {
            $fmt=New-Object System.Drawing.StringFormat; $fmt.Alignment='Center'; $fmt.LineAlignment='Center'
            $path=New-Object System.Drawing.Drawing2D.GraphicsPath
            $path.AddString($text,$font.FontFamily,[int]$font.Style,$font.Size,(New-Object System.Drawing.RectangleF(35,$y,1850,145)),$fmt)
            $pen=New-Object System.Drawing.Pen([System.Drawing.Color]::Black,14); $pen.LineJoin='Round'
            $g.DrawPath($pen,$path); $g.FillPath([System.Drawing.Brushes]::White,$path)
            $pen.Dispose(); $path.Dispose(); $fmt.Dispose()
        }
        $font=New-Object System.Drawing.Font('Impact',78,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
        $i=0
        foreach($it in $Items) {
            $i++; $in=Join-Path $WallSrc $it.s; if(-not(Test-Path -LiteralPath $in)){continue}
            $bmp=New-Object System.Drawing.Bitmap 1920,1080; $g=[System.Drawing.Graphics]::FromImage($bmp)
            $g.SmoothingMode='HighQuality'; $g.InterpolationMode='HighQualityBicubic'; $g.TextRenderingHint='AntiAliasGridFit'
            $r=New-Object System.Drawing.Rectangle 0,0,1920,1080
            $grad=New-Object System.Drawing.Drawing2D.LinearGradientBrush($r,[System.Drawing.Color]::FromArgb(15,52,96),[System.Drawing.Color]::FromArgb(111,45,119),35)
            $g.FillRectangle($grad,$r); $grad.Dispose()
            $img=[System.Drawing.Image]::FromFile($in)
            $scale=[Math]::Min(1180/$img.Width,760/$img.Height); $dw=[int]($img.Width*$scale); $dh=[int]($img.Height*$scale); $x=[int]((1920-$dw)/2); $y=[int]((1080-$dh)/2)
            $shadow=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(95,0,0,0)); $g.FillRectangle($shadow,$x+18,$y+18,$dw,$dh); $shadow.Dispose()
            $g.DrawImage($img,$x,$y,$dw,$dh); $img.Dispose()
            Draw-MemeText $g $it.a 20 $font; Draw-MemeText $g $it.b 910 $font
            $g.Dispose(); $out=Join-Path $WallRoot ('wallpaper-{0:D2}.jpg' -f $i); $bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
        }
        $font.Dispose()
        Add-Action "WALLPAPERS_CREATED $((Get-ChildItem -LiteralPath $WallRoot -Filter 'wallpaper-*.jpg').Count)"
    } catch { Add-Failure "WALLPAPER_BUILD :: $($_.Exception.Message)" }

    $Rotate = Join-Path $WallRoot 'rotate.ps1'
    @'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KaiWallpaper { [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SystemParametersInfo(int a,int b,string c,int d); }
"@
$Root='C:\Users\AwesomeKai\Pictures\2011 Meme Rotation'
$Pics=Get-ChildItem -LiteralPath $Root -Filter 'wallpaper-*.jpg'|Sort-Object Name
if(!$Pics){exit 1}
$State=Join-Path $Root '.index';$i=-1
if(Test-Path -LiteralPath $State){$raw=(Get-Content -LiteralPath $State -Raw).Trim();if($raw -match '^\d+$'){$i=[int]$raw}}
$i=($i+1)%$Pics.Count; Set-Content -LiteralPath $State -Value $i -NoNewline
Set-ItemProperty 'HKCU:\Control Panel\Desktop' WallpaperStyle '10'; Set-ItemProperty 'HKCU:\Control Panel\Desktop' TileWallpaper '0'
[void][KaiWallpaper]::SystemParametersInfo(20,0,$Pics[$i].FullName,3)
'@ | Set-Content -LiteralPath $Rotate -Encoding UTF8

    # Disable only user-root wallpaper generators that clearly identify themselves as AI/image generation.
    Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
        $task=$_; $acts=(($task.Actions|ForEach-Object{"$($_.Execute) $($_.Arguments)"}) -join ' | ')
        $looksWallpaper=($task.TaskName -match 'wallpaper|background') -or ($acts -match 'wallpaper|background')
        $looksAI=($task.TaskName -match 'AI|imagegen|image-gen|generator') -or ($acts -match 'openai|imagegen|image-gen|generate.*wall|wall.*generate|AI.*wall|wall.*AI')
        $looksUser=($task.TaskPath -eq '\') -or ($acts -match [regex]::Escape($UserRoot))
        if($looksWallpaper -and $looksAI -and $looksUser -and $task.TaskName -ne 'Kai 2011 Meme Rotation') {
            try { Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop | Out-Null; Add-Action "DISABLED_OLD_AI_WALLPAPER_TASK $($task.TaskPath)$($task.TaskName) actions=$acts" } catch { Add-Failure "TASK_DISABLE $($task.TaskName) :: $($_.Exception.Message)" }
        } elseif($looksWallpaper) { Add-Action "WALLPAPER_TASK_OBSERVED $($task.TaskPath)$($task.TaskName) actions=$acts" }
    }

    try {
        $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Rotate`"")
        $triggers=@(
            (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
            (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15))
        )
        $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName 'Kai 2011 Meme Rotation' -Action $action -Trigger $triggers -Principal $principal -Description 'Classic web meme rotation, 2011-ish; replaces AI-subject wallpaper generators.' -Force | Out-Null
        & $Rotate
        Add-Action 'WALLPAPER_ROTATION_INSTALLED interval=15m task=Kai 2011 Meme Rotation'
    } catch { Add-Failure "WALLPAPER_TASK :: $($_.Exception.Message)" }
}

Write-Host ''
Write-Host '## GPU / disk after'
Invoke-Quiet { & nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader } 'nvidia-smi after'
Invoke-Quiet { & nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader } 'nvidia-smi apps after'
$AfterFree=(Get-PSDrive C -ErrorAction SilentlyContinue).Free
Write-Host "free_before_bytes=$BeforeFree"
Write-Host "free_after_bytes=$AfterFree"
Write-Host "free_delta_bytes=$($AfterFree-$BeforeFree)"
Write-Host "estimated_removed_bytes=$FreedEstimate"
Write-Host "removed_items=$RemovedCount"
Write-Host "failures=$($Failed.Count)"
if($Failed.Count){$Failed|ForEach-Object{"FAILURE $_"}}
Write-Host ''
Write-Host '## Next-pass candidates'
Write-Host '- Review exact duplicate groups; delete only copies whose canonical/shareable role is proven.'
Write-Host '- Repair V13 Unicode filename anomaly as an exact old-path -> new-path transaction with before/after hashes.'
Write-Host '- Reassess PWA 2.50 GB release bundle separately: duplicate storage vs ready-to-share artifact.'
Write-Host '- Re-run process/service inventory after cleanup before killing any generic Python/Node/WSL process.'
Write-Host ''
Write-Host "finished: $((Get-Date).ToString('o'))"
Stop-Transcript | Out-Null

$Body = Get-Content -LiteralPath $TmpTranscript -Raw -ErrorAction SilentlyContinue
Set-Content -LiteralPath $Receipt -Value $Body -Encoding UTF8
if (Test-Path -LiteralPath $EvidenceReceipt) {
    Add-Content -LiteralPath $EvidenceReceipt -Value ("`r`n`r`n---`r`n`r`n" + $Body) -Encoding UTF8
}
Remove-Item -LiteralPath $TmpTranscript -Force -ErrorAction SilentlyContinue
Write-Host "RECEIPT=$Receipt"
