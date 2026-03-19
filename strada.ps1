$ErrorActionPreference = "Stop"
$nodePath = if ($env:STRADA_NODE_PATH) { $env:STRADA_NODE_PATH } else { (Get-Command node -ErrorAction SilentlyContinue)?.Source }
if (-not $nodePath) {
  Write-Host "Strada requires Node.js 20+."
  Write-Host "Install Node.js, then run .\strada.ps1 again."
  exit 1
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceLauncher = Join-Path $rootDir "scripts/source-launcher.mjs"
& $nodePath $sourceLauncher "--wrapper-kind" "powershell" "--wrapper-path" $MyInvocation.MyCommand.Path @args
exit $LASTEXITCODE
