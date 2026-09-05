# ============================================================
#  run-flow.ps1  画面を通した通しテスト
#
#  index.html に flow-inject.js を差し込んだ一時ページを作り、
#  ヘッドレスの Chrome で開いて、本物のボタンを順に押していく。
#  合成した円錐（体積が理論的に分かる）を保存 →「開く」→ 結果表示 →
#  基準面・しきい値の調整 → 断面 → 保存 → 削除、までを自動でなぞる。
#
#  使い方:  powershell -ExecutionPolicy Bypass -File test\run-flow.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $app '_flowtest.html'

# --- Chrome を探す ---
$cands = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $cands | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome も Edge も見つかりませんでした。' }
Write-Host "ブラウザ: $browser"

# --- 一時ページを組み立てる ---
$catch = '<script>window.__errs=[];window.addEventListener("error",function(e){window.__errs.push((e.message||"?")+" @"+((e.filename||"").split("/").pop())+":"+(e.lineno||""));});window.addEventListener("unhandledrejection",function(e){window.__errs.push("promise: "+(e.reason&&e.reason.message||e.reason));});</script>'
$html = Get-Content (Join-Path $app 'index.html') -Raw -Encoding UTF8
$inject = Get-Content (Join-Path $PSScriptRoot 'flow-inject.js') -Raw -Encoding UTF8
$html = $html -replace '(?<=<body>)', "`n$catch"
$html = $html -replace '(?=</body>)', "$inject`n"
Set-Content -LiteralPath $tmp -Value $html -Encoding UTF8 -NoNewline

# --- 走らせる ---
$out = Join-Path $env:TEMP 'doryo_flow_out.html'
$errf = Join-Path $env:TEMP 'doryo_flow_err.txt'
$url = 'file:///' + ($tmp -replace '\\', '/')
$args = @('--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
          '--disable-background-networking', '--window-size=420,900',
          '--virtual-time-budget=200000', '--dump-dom', $url)
Start-Process -FilePath $browser -ArgumentList $args -NoNewWindow -Wait `
              -RedirectStandardOutput $out -RedirectStandardError $errf

# --- 結果を取り出す ---
$dom = Get-Content -LiteralPath $out -Raw -Encoding UTF8
$res = [regex]::Match($dom, '(?s)<pre id="__smoke">(.*?)</pre>').Groups[1].Value
Remove-Item -LiteralPath $tmp -Force

if (-not $res) {
  Write-Host '結果が取り出せませんでした（ページが最後まで動いていない可能性）' -ForegroundColor Red
  exit 1
}
$res = $res -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&amp;', '&'
Write-Host ''
$res -split "`n" | ForEach-Object {
  if ($_ -match '^NG|RESULT FAIL|RESULT STALL') { Write-Host $_ -ForegroundColor Red }
  elseif ($_ -match '^RESULT PASS') { Write-Host $_ -ForegroundColor Green }
  else { Write-Host $_ }
}
if ($res -match 'RESULT PASS') { exit 0 } else { exit 1 }
