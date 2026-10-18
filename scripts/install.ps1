# wadigest installer for Windows 10/11. Double-click "Start wadigest.cmd", or run:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Installs a private Node.js and wacli into %USERPROFILE%\.wadigest (no admin needed), then opens setup.
param([switch]$NoSetup)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppDir = Split-Path -Parent $PSScriptRoot
$WdHome = if ($env:WADIGEST_HOME) { $env:WADIGEST_HOME } else { Join-Path $env:USERPROFILE '.wadigest' }
$BinDir = Join-Path $WdHome 'bin'
$Runtime = Join-Path $WdHome 'runtime'
New-Item -ItemType Directory -Force -Path $BinDir, $Runtime, (Join-Path $WdHome 'logs') | Out-Null

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "[x] $m" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
function Sha256($f) { (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower() }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
Say "wadigest installer (windows/$arch)"

# ---------- Node.js 20+ ----------
$node = $null
$privNode = Join-Path $Runtime 'node\node.exe'
if (Test-Path $privNode) { $node = $privNode }
else {
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) { $v = & $sys.Source -p "process.versions.node.split('.')[0]"; if ([int]$v -ge 20) { $node = $sys.Source } }
}
if (-not $node) {
  Say 'Downloading Node.js (private copy for wadigest)'
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Fail "No Node.js build for win-$arch" }
  $want, $name = ($line.Trim() -split '\s+')
  $tmp = Join-Path $env:TEMP $name
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $tmp
  if ((Sha256 $tmp) -ne $want) { Fail 'Node.js download failed its checksum check' }
  Expand-Archive -Force $tmp $Runtime
  Remove-Item -Recurse -Force (Join-Path $Runtime 'node') -ErrorAction SilentlyContinue
  Rename-Item (Join-Path $Runtime ($name -replace '\.zip$', '')) 'node'
  Remove-Item $tmp
  $node = $privNode
}
Ok "Node $(& $node -v)"

# ---------- wacli ----------
$wacli = Join-Path $BinDir 'wacli.exe'
$pinRepo = if ($env:WADIGEST_REPO) { $env:WADIGEST_REPO } else { 'sgaabdu4/wadigest' }
$pinBase = "https://github.com/$pinRepo/releases/download/wacli-fork-v0.22.0"
$hasPin = (Test-Path $wacli) -and ((& $wacli messages pin --help 2>$null) -match 'unpin')
if (-not $hasPin) {
  try {
    Say 'Downloading wacli with message pinning'
    $tmp = Join-Path $env:TEMP 'wacli-pin_windows_amd64.tar.gz'
    Invoke-WebRequest -UseBasicParsing "$pinBase/wacli-pin_windows_amd64.tar.gz" -OutFile $tmp
    $sums = (Invoke-WebRequest -UseBasicParsing "$pinBase/checksums.txt").Content -split "`n"
    $want = (($sums | Where-Object { $_ -match 'wacli-pin_windows_amd64\.tar\.gz$' }) -split '\s+')[0]
    if ((Sha256 $tmp) -ne $want) { throw 'checksum' }
    $x = Join-Path $env:TEMP 'wacli-pin-extract'
    Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $x | Out-Null
    tar -xzf $tmp -C $x
    Copy-Item -Force (Join-Path $x 'wacli.exe') $wacli
    Remove-Item -Recurse -Force $x, $tmp
    Ok 'pinning ready'
  } catch { Write-Host '  pinning download not available, using plain wacli (pin the digest by hand)' -ForegroundColor Yellow }
}
if (-not (Test-Path $wacli)) {
  Say 'Downloading wacli from GitHub releases'
  $rel = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/openclaw/wacli/releases/latest' -Headers @{ 'User-Agent' = 'wadigest' }
  $ver = $rel.tag_name -replace '^v', ''
  $asset = $rel.assets | Where-Object { $_.name -match "^wacli_${ver}_windows_amd64\.(zip|tar\.gz)$" } | Select-Object -First 1
  $sumsAsset = $rel.assets | Where-Object { $_.name -eq 'checksums.txt' } | Select-Object -First 1
  if (-not $asset) { Fail 'No Windows build of wacli found in the latest release' }
  $tmp = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $tmp
  if ($sumsAsset) {
    $sums = (Invoke-WebRequest -UseBasicParsing $sumsAsset.browser_download_url).Content -split "`n"
    $want = (($sums | Where-Object { $_ -match [regex]::Escape($asset.name) + '$' }) -split '\s+')[0]
    if ((Sha256 $tmp) -ne $want) { Fail 'wacli download failed its checksum check' }
  }
  $x = Join-Path $env:TEMP 'wacli-extract'
  Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
  if ($asset.name -like '*.zip') { Expand-Archive -Force $tmp $x } else { New-Item -ItemType Directory $x | Out-Null; tar -xzf $tmp -C $x }
  Copy-Item (Get-ChildItem -Recurse $x -Filter 'wacli.exe' | Select-Object -First 1).FullName $wacli
  Remove-Item -Recurse -Force $x, $tmp
}
Ok "wacli $(& $wacli --version)"

# ---------- wadigest command ----------
$shim = Join-Path $BinDir 'wadigest.cmd'
Set-Content -Encoding ASCII $shim "@echo off`r`nset `"WADIGEST_HOME=$WdHome`"`r`n`"$node`" `"$AppDir\bin\wadigest.js`" %*`r`n"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $BinDir })) {
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
}
$env:Path = "$BinDir;$env:Path"
$env:WADIGEST_HOME = $WdHome
Ok "wadigest command: $shim"
Set-Content -Encoding ASCII (Join-Path $WdHome 'installed') ((Get-Date).ToUniversalTime().ToString('s') + 'Z')

& $node "$AppDir\bin\wadigest.js" doctor
if (-not $NoSetup) {
  Say 'Opening setup'
  & $node "$AppDir\bin\wadigest.js" setup
}
