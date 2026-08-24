# Copies the live gateway sources into the cloud-function bundle before deploy.
# Run from anywhere: powershell -File cloudbase\sync-gateway.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'gateway'
$dst = Join-Path $PSScriptRoot 'anydoorApi\gateway'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($name in @('server.mjs', 'app.js', 'index.html', 'styles.css', 'package.json')) {
  Copy-Item (Join-Path $src $name) (Join-Path $dst $name) -Force
}
Write-Output "gateway synced into $dst"
