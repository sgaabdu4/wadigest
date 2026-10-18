# One-command install for Windows 10/11 (PowerShell):
#   irm https://raw.githubusercontent.com/sgaabdu4/wadigest/main/get.ps1 | iex
# Downloads wadigest into %USERPROFILE%\.wadigest\app (replacing any older copy), then runs its installer.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = if ($env:WADIGEST_REPO) { $env:WADIGEST_REPO } else { 'sgaabdu4/wadigest' }
$ref = if ($env:WADIGEST_REF) { $env:WADIGEST_REF } else { 'main' }
$wdHome = if ($env:WADIGEST_HOME) { $env:WADIGEST_HOME } else { Join-Path $env:USERPROFILE '.wadigest' }
$app = Join-Path $wdHome 'app'

Write-Host '==> Downloading wadigest' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $wdHome | Out-Null
$zip = Join-Path $env:TEMP 'wadigest.zip'
$unz = Join-Path $env:TEMP 'wadigest-unzip'
Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$repo/zip/refs/heads/$ref" -OutFile $zip
if (Test-Path $unz) { Remove-Item -Recurse -Force $unz }
Expand-Archive -Path $zip -DestinationPath $unz
$src = Get-ChildItem $unz -Directory | Select-Object -First 1
if (-not (Test-Path (Join-Path $src.FullName 'scripts\install.ps1'))) { throw 'The download looks wrong (no scripts\install.ps1).' }
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item $src.FullName $app
Remove-Item -Recurse -Force $unz, $zip

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts\install.ps1')
