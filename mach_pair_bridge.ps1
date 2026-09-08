$ErrorActionPreference='Continue'
$Repo='Pokitomas/theawesomehexapp'
$StatePath='mach_pair_state.txt'
$ReceiptPath='mach_pair_receipt.txt'
$env:PYTHONPATH='C:\Users\AwesomeKai'
$Py='C:\Python314\python.exe'
if(!(Test-Path $Py)){$Py=(Get-Command python.exe).Source}
Add-Type -AssemblyName System.Windows.Forms

function Get-State {
  $b64=& gh api "repos/$Repo/contents/$StatePath?ref=main" --jq .content 2>$null
  if(!$b64){return $null}
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($b64 -join '').Replace("`n",'')))
}
function Put-Receipt([string]$text){
  $sha=& gh api "repos/$Repo/contents/$ReceiptPath?ref=main" --jq .sha 2>$null
  $enc=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
  if($sha){ & gh api -X PUT "repos/$Repo/contents/$ReceiptPath" -f message='pair receipt' -f content=$enc -f sha=$sha 1>$null }
  else { & gh api -X PUT "repos/$Repo/contents/$ReceiptPath" -f message='pair receipt' -f content=$enc 1>$null }
}
function Parse-State([string]$s){
  $h=@{}
  foreach($line in ($s -split "`r?`n")){
    $i=$line.IndexOf('='); if($i -gt 0){$h[$line.Substring(0,$i)]=$line.Substring($i+1)}
  }
  return $h
}
function Resident([string]$mode,[string]$payload=''){
  $code=@'
import sys,json,ctypes,time,base64
from mach.core.computer import connect
c=connect(start=False)
mode=sys.argv[1]; payload=sys.argv[2] if len(sys.argv)>2 else ''
if mode=='snapshot':
 print(json.dumps({'catalog':c.do('catalog'),'windows':c.do('windows')},default=str))
elif mode=='mach_f1':
 s=c.do('windows'); w=next(x for x in s['windows'] if x.get('title','').strip().lower()=='mach')
 r=c.do('focus',target='Mach'); u=ctypes.windll.user32; u.SetForegroundWindow(int(w['hwnd'])); time.sleep(.15); u.keybd_event(0x70,0,0,0); time.sleep(.04); u.keybd_event(0x70,0,2,0); print(json.dumps({'focus':r,'foreground':int(u.GetForegroundWindow()),'f1':True},default=str))
elif mode=='claude':
 s=c.do('windows'); w=next(x for x in s['windows'] if x.get('title','').strip().lower()=='claude')
 r=c.do('focus',target='Claude'); u=ctypes.windll.user32; u.SetForegroundWindow(int(w['hwnd'])); time.sleep(.15); print(json.dumps({'focus':r,'foreground':int(u.GetForegroundWindow())},default=str))
'@
  return (& $Py -c $code $mode $payload 2>&1 | Out-String).Trim()
}

$last=''
Put-Receipt "PAIR_BRIDGE_READY $(Get-Date -Format o)"
while($true){
  $raw=Get-State
  if($raw){
    $x=Parse-State $raw
    $id=$x['id']; $op=$x['op']
    if($id -and $id -ne $last){
      $last=$id
      try{
        if($op -eq 'snapshot'){
          $r=Resident 'snapshot'; Put-Receipt "id=$id`nok=1`nop=snapshot`n$r"
        } elseif($op -eq 'mach_f1'){
          $r=Resident 'mach_f1'; Put-Receipt "id=$id`nok=1`nop=mach_f1`n$r"
        } elseif($op -eq 'claude'){
          $r=Resident 'claude'
          $txt=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x['payload_b64']))
          Set-Clipboard -Value $txt
          Start-Sleep -Milliseconds 120
          [System.Windows.Forms.SendKeys]::SendWait('^v')
          Start-Sleep -Milliseconds 80
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          Put-Receipt "id=$id`nok=1`nop=claude`n$r"
        } else { Put-Receipt "id=$id`nok=0`nerror=unsupported_op" }
      } catch { Put-Receipt "id=$id`nok=0`nerror=$($_.Exception.Message)" }
    }
  }
  Start-Sleep -Milliseconds 650
}
