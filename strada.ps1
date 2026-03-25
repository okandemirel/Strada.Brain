$ErrorActionPreference = "Stop"

# --- Node.js resolution with automatic portable download ---
function Find-StradaNode {
  # 1. Explicit override
  if ($env:STRADA_NODE_PATH) { return $env:STRADA_NODE_PATH }

  # 2. System-installed node
  $systemNode = (Get-Command node -ErrorAction SilentlyContinue)
  if ($systemNode) { return $systemNode.Source }

  # 3. Strada-managed portable node
  $stradaLocal = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
  $portableNode = Join-Path $stradaLocal "Strada\node\node.exe"
  if (Test-Path $portableNode) { return $portableNode }

  return $null
}

function Install-StradaNode {
  $stradaLocal = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
  $nodeDir = Join-Path $stradaLocal "Strada\node"
  $portableNode = Join-Path $nodeDir "node.exe"

  if (Test-Path $portableNode) { return $portableNode }

  $nodeVersion = "v22.18.0"
  # Detect architecture
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") { "arm64" } else { "x64" }
  $zipName = "node-${nodeVersion}-win-${arch}.zip"
  $url = "https://nodejs.org/dist/${nodeVersion}/${zipName}"

  Write-Host ""
  Write-Host "Node.js is not installed on this system."
  Write-Host "Strada requires Node.js 20+ to run."
  Write-Host ""
  Write-Host "Strada can download a portable Node.js ($nodeVersion $arch) automatically."
  Write-Host "It will be installed to: $nodeDir"
  Write-Host "This is a one-time download (~30 MB) and will NOT modify your system PATH."
  Write-Host ""

  $response = Read-Host "Download portable Node.js now? [Y/n]"
  if ($response -and $response.ToLower() -ne "y" -and $response.ToLower() -ne "yes" -and $response -ne "") {
    if ($response.ToLower() -eq "n" -or $response.ToLower() -eq "no") {
      Write-Host ""
      Write-Host "You can install Node.js manually from https://nodejs.org"
      Write-Host "Or set STRADA_NODE_PATH to point to your node.exe"
      exit 1
    }
  }

  Write-Host ""
  Write-Host "Downloading Node.js ${nodeVersion} (${arch})..."

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "strada-node-install"
  $zipPath = Join-Path $tempDir $zipName

  try {
    # Create temp and target directories
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null

    # Download
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    Write-Host "Extracting..."

    # Extract the zip
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

    # The zip contains a folder like node-v22.18.0-win-x64/
    $extractedFolder = Join-Path $tempDir "node-${nodeVersion}-win-${arch}"

    # Copy node.exe and npm files to the target directory
    Copy-Item (Join-Path $extractedFolder "node.exe") $nodeDir -Force

    # Copy npm-related files
    $npmItems = @("npm", "npm.cmd", "npx", "npx.cmd", "corepack", "corepack.cmd", "node_modules")
    foreach ($item in $npmItems) {
      $src = Join-Path $extractedFolder $item
      if (Test-Path $src) {
        $dest = Join-Path $nodeDir $item
        if (Test-Path $src -PathType Container) {
          Copy-Item $src $dest -Recurse -Force
        } else {
          Copy-Item $src $dest -Force
        }
      }
    }

    Write-Host "Node.js ${nodeVersion} installed to $nodeDir"
    Write-Host ""

    return $portableNode
  }
  catch {
    Write-Host ""
    Write-Host "Failed to download Node.js: $_"
    Write-Host ""
    Write-Host "You can install Node.js manually from https://nodejs.org"
    Write-Host "Or download it yourself and set STRADA_NODE_PATH=<path-to-node.exe>"
    exit 1
  }
  finally {
    # Clean up temp files
    if (Test-Path $tempDir) {
      Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

$nodePath = Find-StradaNode
if (-not $nodePath) {
  $nodePath = Install-StradaNode
}

# Verify node actually works
try {
  $nodeVer = & $nodePath --version 2>&1
  $major = [int]($nodeVer -replace '^v(\d+)\..*', '$1')
  if ($major -lt 20) {
    Write-Host "Strada requires Node.js 20+, but found $nodeVer"
    Write-Host "Please update Node.js or set STRADA_NODE_PATH to a newer version."
    exit 1
  }
} catch {
  Write-Host "Failed to verify Node.js at: $nodePath"
  Write-Host "Error: $_"
  exit 1
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceLauncher = Join-Path $rootDir "scripts\source-launcher.mjs"
$env:STRADA_NODE_PATH = $nodePath

# Ensure the directory containing node (and npm) is on PATH for child processes
$nodeDir = Split-Path -Parent $nodePath
if ($env:PATH -notlike "*$nodeDir*") {
  $env:PATH = "$nodeDir;$env:PATH"
}

& $nodePath $sourceLauncher "--wrapper-kind" "powershell" "--wrapper-path" $MyInvocation.MyCommand.Path @args
exit $LASTEXITCODE
