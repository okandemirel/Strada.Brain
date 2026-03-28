import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON = path.join(ROOT_DIR, "package.json");
const DIST_ENTRY = path.join(ROOT_DIR, "dist", "index.js");
const SOURCE_ENTRY = path.join(ROOT_DIR, "src", "index.ts");
const MANAGED_BLOCK_START = "# >>> Strada command >>>";
const MANAGED_BLOCK_END = "# <<< Strada command <<<";
const STRADA_LAUNCH_CWD_ENV = "STRADA_LAUNCH_CWD";
const DEFAULT_RUNTIME_PURGE_TARGETS = [
  { key: "MEMORY_DB_PATH", fallback: ".strada-memory" },
  { key: "WHATSAPP_SESSION_PATH", fallback: ".whatsapp-session" },
  { key: "LOG_FILE", fallback: "strada-brain.log" },
  { key: "DAEMON_HEARTBEAT_FILE", fallback: "./HEARTBEAT.md" },
  { key: "", fallback: "strada-brain-error.log" },
  { key: "", fallback: "strada-brain-sync.log" },
  { key: "", fallback: ".strada-update.lock" },
  { key: "", fallback: "data/tasks.db" },
  { key: "", fallback: "data/learning.db" },
];
const DEFAULT_SOURCE_PREPARED_PURGE_TARGETS = [
  { fallback: "dist" },
  { fallback: "node_modules" },
  { fallback: "web-portal/dist" },
  { fallback: "web-portal/node_modules" },
];

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function getSafeCurrentWorkingDirectory(fallback) {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

function resolveLaunchCwd(env = process.env, fallback = os.homedir()) {
  const configured = env[STRADA_LAUNCH_CWD_ENV]?.trim();
  if (configured) {
    return configured;
  }
  return getSafeCurrentWorkingDirectory(fallback);
}

function quotePosixSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteCmdDouble(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureRepositoryRoot() {
  if (!existsSync(PACKAGE_JSON)) {
    console.error(`Could not find package.json in ${ROOT_DIR}`);
    console.error("Run this launcher from the Strada.Brain repository root.");
    process.exit(1);
  }
}

function printMissingNpm() {
  console.error("Strada requires npm so it can prepare the local checkout.");
  console.error("npm usually ships with Node.js. Ensure your Node.js installation includes npm,");
  console.error("or re-run the Strada launcher (strada.cmd / strada.ps1) to trigger the automatic Node.js setup.");
}

function resolveCommandBinary(command, platform = process.platform) {
  if (!isWindows(platform)) {
    return command;
  }
  // When using a portable/standalone Node.js (STRADA_NODE_PATH), npm.cmd lives
  // next to node.exe and may not be on the system PATH.  Resolve the full path
  // so that `execFileSync` / `spawnSync` find it regardless of PATH.
  const nodeDir = process.env.STRADA_NODE_PATH ? path.dirname(process.env.STRADA_NODE_PATH) : null;
  if (nodeDir) {
    const candidate = path.join(nodeDir, `${command}.cmd`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return `${command}.cmd`;
}

/**
 * Build spawn options that work correctly on Windows.
 *
 * Node.js 22+ rejects `.cmd`/`.bat` execution via `spawn`/`execFile` without
 * `shell: true` (CVE-2024-27980). We add `shell: true` on Windows so that the
 * underlying CreateProcess call is handled by cmd.exe, which knows how to
 * launch `.cmd` stubs such as `npm.cmd`.
 */
function windowsSafeSpawnOptions(options = {}) {
  if (isWindows()) {
    return { ...options, shell: true };
  }
  return options;
}

function ensureSourceCheckout() {
  ensureRepositoryRoot();
  const npmCommand = resolveCommandBinary("npm");
  try {
    execFileSync(npmCommand, ["--version"], windowsSafeSpawnOptions({ stdio: "ignore" }));
  } catch {
    printMissingNpm();
    process.exit(1);
  }

  if (!existsSync(path.join(ROOT_DIR, "node_modules"))) {
    console.log("Preparing Strada dependencies...");
    const result = spawnSync(npmCommand, ["install"], windowsSafeSpawnOptions({
      cwd: ROOT_DIR,
      stdio: "inherit",
    }));
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

function ensurePrepared() {
  ensureSourceCheckout();
  if (!existsSync(DIST_ENTRY)) {
    console.log("Preparing Strada build...");
    const result = spawnSync(resolveCommandBinary("npm"), ["run", "bootstrap"], windowsSafeSpawnOptions({
      cwd: ROOT_DIR,
      stdio: "inherit",
    }));
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

function normalizeWindowsPathEntry(value) {
  return String(value).replace(/[\\/]+$/, "").toLowerCase();
}

function normalizePathForComparison(value, platform = process.platform) {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathImpl.resolve(String(value));
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function pathsEqual(left, right, platform = process.platform) {
  return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
}

function isWithinPath(targetPath, parentPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function mergeWindowsUserPath(existingPath, installDir) {
  const current = String(existingPath ?? "").trim();
  const present = current
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => normalizeWindowsPathEntry(entry) === normalizeWindowsPathEntry(installDir));

  if (present) {
    return {
      updated: false,
      path: current,
    };
  }

  return {
    updated: true,
    path: current ? `${installDir};${current}` : installDir,
  };
}

export function removeWindowsUserPath(existingPath, installDir) {
  const current = String(existingPath ?? "").trim();
  if (!current) {
    return {
      updated: false,
      path: "",
    };
  }

  const remaining = current
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => normalizeWindowsPathEntry(entry) !== normalizeWindowsPathEntry(installDir));
  const next = remaining.join(";");

  return {
    updated: next !== current,
    path: next,
  };
}

function hasWindowsPathEntry(existingPath, installDir) {
  return !mergeWindowsUserPath(existingPath, installDir).updated;
}

function defaultWindowsPathSync(installDir) {
  const readScript = "[Environment]::GetEnvironmentVariable('Path','User')";
  const existing = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", readScript],
    { encoding: "utf8" },
  ).trim();
  const merged = mergeWindowsUserPath(existing, installDir);
  if (merged.updated) {
    const escapedPath = quotePowerShellSingle(merged.path);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Environment]::SetEnvironmentVariable('Path', ${escapedPath}, 'User')`,
      ],
      { stdio: "ignore" },
    );
  }
  return merged;
}

function defaultWindowsPathRemoveSync(installDir) {
  const readScript = "[Environment]::GetEnvironmentVariable('Path','User')";
  const existing = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", readScript],
    { encoding: "utf8" },
  ).trim();
  const updated = removeWindowsUserPath(existing, installDir);
  if (updated.updated) {
    const escapedPath = quotePowerShellSingle(updated.path);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Environment]::SetEnvironmentVariable('Path', ${escapedPath}, 'User')`,
      ],
      { stdio: "ignore" },
    );
  }
  return updated;
}

function defaultWindowsDeferredDelete(targetPaths, installDir) {
  const existingTargets = targetPaths.filter((targetPath) => existsSync(targetPath));
  if (existingTargets.length === 0) {
    return false;
  }

  const deleteCommands = existingTargets
    .map((targetPath) => `del /f /q ${quoteCmdDouble(targetPath)} >nul 2>nul`)
    .join(" & ");
  const cleanupScript = [
    "ping 127.0.0.1 -n 3 >nul",
    deleteCommands,
    `if exist ${quoteCmdDouble(installDir)} rd ${quoteCmdDouble(installDir)} >nul 2>nul`,
  ].join(" & ");

  const cleanupProcess = spawn("cmd.exe", ["/d", "/s", "/c", cleanupScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  cleanupProcess.unref();
  return true;
}

function getPosixInstallDir(env = process.env, homeDir = os.homedir()) {
  return env.XDG_BIN_HOME || path.join(homeDir, ".local", "bin");
}

function getWindowsLocalAppData(env = process.env, homeDir = os.homedir()) {
  return env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
}

function getWindowsInstallDir(env = process.env, homeDir = os.homedir()) {
  return path.join(getWindowsLocalAppData(env, homeDir), "Strada", "bin");
}

function resolveStradaHome(env = process.env, homeDir = os.homedir(), cwd = homeDir, platform = process.platform) {
  const configured = env.STRADA_HOME?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(cwd, configured);
  }
  if (platform === "win32") {
    return path.join(getWindowsLocalAppData(env, homeDir), "Strada");
  }
  return path.join(homeDir, ".strada");
}

function resolveRuntimeRoots(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const installRoot = options.rootDir || ROOT_DIR;
  const cwd = options.cwd || resolveLaunchCwd(env, homeDir);
  const sourceCheckout = options.sourceCheckout
    ?? (env.STRADA_SOURCE_CHECKOUT === "true" || existsSync(path.join(installRoot, ".git")));
  return {
    installRoot,
    sourceCheckout,
    configRoot: sourceCheckout ? installRoot : resolveStradaHome(env, homeDir, cwd, platform),
  };
}

function getDefaultLauncherPath(wrapperKind) {
  if (wrapperKind === "powershell") return path.join(ROOT_DIR, "strada.ps1");
  if (wrapperKind === "cmd") return path.join(ROOT_DIR, "strada.cmd");
  return path.join(ROOT_DIR, "strada");
}

function buildPosixWrapper({ wrapperPath }) {
  const nodeBinExpr = "${STRADA_NODE_PATH:-node}";
  return `#!/bin/sh
NODE_BIN="${nodeBinExpr}"
exec "$NODE_BIN" ${quotePosixSingle(path.join(ROOT_DIR, "scripts", "source-launcher.mjs"))} --wrapper-kind posix --wrapper-path ${quotePosixSingle(wrapperPath)} "$@"
`;
}

function buildPowerShellWrapper() {
  const sourceLauncherPath = quotePowerShellSingle(path.join(ROOT_DIR, "scripts", "source-launcher.mjs"));
  return `$ErrorActionPreference = "Stop"
# --- Node.js resolution with portable fallback ---
$nodePath = $null
if ($env:STRADA_NODE_PATH) { $nodePath = $env:STRADA_NODE_PATH }
if (-not $nodePath) { $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodePath) {
  $stradaLocal = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\\Local' }
  $portable = Join-Path $stradaLocal 'Strada\\node\\node.exe'
  if (Test-Path $portable) { $nodePath = $portable }
}
if (-not $nodePath) {
  $stradaLocal = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\\Local' }
  $nodeDir = Join-Path $stradaLocal 'Strada\\node'
  $nodeVer = 'v22.18.0'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  Write-Host ''; Write-Host 'Node.js is not installed. Strada can download a portable copy (~30 MB, one-time).'
  Write-Host "Install to: $nodeDir"; Write-Host ''
  $r = Read-Host 'Download portable Node.js now? [Y/n]'
  if ($r -and $r.ToLower() -eq 'n') { Write-Host 'Install Node.js from https://nodejs.org or set STRADA_NODE_PATH'; exit 1 }
  $zip = "node-$nodeVer-win-$arch.zip"; $url = "https://nodejs.org/dist/$nodeVer/$zip"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) 'strada-node-install'
  try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null; New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'; Write-Host "Downloading Node.js $nodeVer ($arch)..."
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $zip) -UseBasicParsing
    Expand-Archive -Path (Join-Path $tmp $zip) -DestinationPath $tmp -Force
    $ex = Join-Path $tmp "node-$nodeVer-win-$arch"
    Copy-Item (Join-Path $ex 'node.exe') $nodeDir -Force
    foreach ($f in @('npm','npm.cmd','npx','npx.cmd','corepack','corepack.cmd')) { $s = Join-Path $ex $f; if (Test-Path $s) { Copy-Item $s $nodeDir -Force } }
    $nm = Join-Path $ex 'node_modules'; if (Test-Path $nm) { Copy-Item $nm (Join-Path $nodeDir 'node_modules') -Recurse -Force }
    Write-Host "Installed Node.js $nodeVer to $nodeDir"
    $nodePath = Join-Path $nodeDir 'node.exe'
  } catch { Write-Host "Download failed: $_"; Write-Host 'Install Node.js from https://nodejs.org'; exit 1 }
  finally { if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } }
}
$env:STRADA_NODE_PATH = $nodePath
$nd = Split-Path -Parent $nodePath; if ($env:PATH -notlike "*$nd*") { $env:PATH = "$nd;$env:PATH" }
$launcherPath = $MyInvocation.MyCommand.Path
& $nodePath ${sourceLauncherPath} '--wrapper-kind' 'powershell' '--wrapper-path' $launcherPath @args
exit $LASTEXITCODE
`;
}

function buildCmdWrapper() {
  const sourceLauncher = path.join(ROOT_DIR, "scripts", "source-launcher.mjs");
  return `@echo off
setlocal EnableDelayedExpansion
set "STRADA_SOURCE_LAUNCHER=${sourceLauncher}"
:: --- Node.js resolution with portable fallback ---
if defined STRADA_NODE_PATH ( set "NODE_EXE=%STRADA_NODE_PATH%" & goto :strada_found )
where node >nul 2>nul
if not errorlevel 1 ( set "NODE_EXE=node" & goto :strada_found )
if defined LOCALAPPDATA ( set "SNDIR=%LOCALAPPDATA%\\Strada\\node" ) else ( set "SNDIR=%USERPROFILE%\\AppData\\Local\\Strada\\node" )
if exist "%SNDIR%\\node.exe" ( set "NODE_EXE=%SNDIR%\\node.exe" & goto :strada_found )
echo. & echo Node.js is not installed. Strada can download a portable copy (~30 MB, one-time).
echo Install to: %SNDIR% & echo.
set /p "CONFIRM=Download portable Node.js now? [Y/n] "
if /i "%CONFIRM%"=="n" ( echo Install Node.js from https://nodejs.org or set STRADA_NODE_PATH & exit /b 1 )
if /i "%CONFIRM%"=="no" ( echo Install Node.js from https://nodejs.org or set STRADA_NODE_PATH & exit /b 1 )
set "ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
set "NV=v22.18.0" & set "ZN=node-%NV%-win-%ARCH%.zip"
echo. & echo Downloading Node.js %NV% (%ARCH%)...
set "TD=%TEMP%\\strada-node-install"
if exist "%TD%" rmdir /s /q "%TD%"
mkdir "%TD%" & mkdir "%SNDIR%" 2>nul
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;$ProgressPreference='SilentlyContinue';Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NV%/%ZN%' -OutFile '%TD%\\%ZN%' -UseBasicParsing;Expand-Archive -Path '%TD%\\%ZN%' -DestinationPath '%TD%' -Force"
if errorlevel 1 ( echo Download failed. Install Node.js from https://nodejs.org & rmdir /s /q "%TD%" 2>nul & exit /b 1 )
set "EX=%TD%\\node-%NV%-win-%ARCH%"
copy /y "%EX%\\node.exe" "%SNDIR%\\node.exe" >nul
for %%F in (npm npm.cmd npx npx.cmd corepack corepack.cmd) do ( if exist "%EX%\\%%F" copy /y "%EX%\\%%F" "%SNDIR%\\%%F" >nul )
if exist "%EX%\\node_modules" xcopy /e /i /q /y "%EX%\\node_modules" "%SNDIR%\\node_modules" >nul
rmdir /s /q "%TD%" 2>nul
echo Installed Node.js %NV% to %SNDIR% & echo.
set "NODE_EXE=%SNDIR%\\node.exe"
:strada_found
for %%I in ("%NODE_EXE%") do set "NDIR=%%~dpI"
set "NDIR=%NDIR:~0,-1%"
echo "%PATH%" | findstr /i /c:"%NDIR%" >nul 2>nul
if errorlevel 1 set "PATH=%NDIR%;%PATH%"
set "STRADA_NODE_PATH=%NODE_EXE%"
"%NODE_EXE%" "%STRADA_SOURCE_LAUNCHER%" --wrapper-kind cmd --wrapper-path "%~f0" %*
exit /b %ERRORLEVEL%
`;
}

function detectProfilePath(env = process.env, homeDir = os.homedir()) {
  const shellName = path.basename(env.SHELL || "sh");
  if (shellName === "fish") {
    return {
      shellName,
      profilePath: path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "fish", "conf.d", "strada.fish"),
    };
  }
  if (shellName === "bash") {
    const bashProfile = path.join(homeDir, ".bash_profile");
    return {
      shellName,
      profilePath: existsSync(bashProfile) ? bashProfile : path.join(homeDir, ".bashrc"),
    };
  }
  if (shellName === "zsh") {
    return {
      shellName,
      profilePath: path.join(env.ZDOTDIR || homeDir, ".zshrc"),
    };
  }
  return {
    shellName,
    profilePath: path.join(homeDir, ".profile"),
  };
}

function getManagedProfilePaths(env = process.env, homeDir = os.homedir()) {
  return Array.from(new Set([
    path.join(env.ZDOTDIR || homeDir, ".zshrc"),
    path.join(homeDir, ".bash_profile"),
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".profile"),
    path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "fish", "conf.d", "strada.fish"),
    detectProfilePath(env, homeDir).profilePath,
  ]));
}

function appendManagedPathBlock(profilePath, installDir, shellName) {
  mkdirSync(path.dirname(profilePath), { recursive: true });
  const content = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  if (content.includes(MANAGED_BLOCK_START)) {
    return false;
  }

  const block = shellName === "fish"
    ? `${MANAGED_BLOCK_START}
if not contains "${installDir}" $PATH
    set -gx PATH "${installDir}" $PATH
end
${MANAGED_BLOCK_END}
`
    : `${MANAGED_BLOCK_START}
case ":$PATH:" in
  *:"${installDir}":*) ;;
  *) export PATH="${installDir}:$PATH" ;;
esac
${MANAGED_BLOCK_END}
`;

  writeFileSync(profilePath, `${content}${content.endsWith("\n") || content.length === 0 ? "" : "\n"}${block}`);
  return true;
}

function stripManagedPathBlock(content) {
  const blockPattern = new RegExp(
    `(?:\\r?\\n)?${escapeRegex(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegex(MANAGED_BLOCK_END)}(?:\\r?\\n)?`,
    "g",
  );
  return content.replace(blockPattern, (match, offset) => {
    if (offset === 0) {
      return "";
    }
    return "\n";
  });
}

function removeManagedPathBlock(profilePath) {
  if (!existsSync(profilePath)) {
    return false;
  }

  const content = readFileSync(profilePath, "utf8");
  if (!content.includes(MANAGED_BLOCK_START)) {
    return false;
  }

  const updated = stripManagedPathBlock(content);
  if (updated.trim().length === 0) {
    rmSync(profilePath, { force: true });
    return true;
  }

  writeFileSync(profilePath, updated, "utf8");
  return true;
}

function writeTextFile(filePath, content, mode) {
  writeFileSync(filePath, content, { encoding: "utf8" });
  if (mode !== undefined) {
    chmodSync(filePath, mode);
  }
}

function removeEntryIfExists(targetPath) {
  if (!existsSync(targetPath)) {
    return false;
  }
  rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function removeDirectoryIfEmpty(dirPath) {
  if (!existsSync(dirPath)) {
    return false;
  }
  if (readdirSync(dirPath).length > 0) {
    return false;
  }
  rmSync(dirPath, { recursive: true, force: true });
  return true;
}

function parseDotenvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const env = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      continue;
    }

    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[match[1]] = value;
  }

  return env;
}

function resolveManagedPath(rootDir, configuredValue, fallback) {
  const raw = String(configuredValue || fallback).trim();
  if (!raw) {
    return null;
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootDir, raw);
}

function purgeRuntimeState(options = {}) {
  const configRoot = options.configRoot;
  const envPath = path.join(configRoot, ".env");
  const envConfig = parseDotenvFile(envPath);
  const removed = [];
  const skipped = [];

  for (const target of DEFAULT_RUNTIME_PURGE_TARGETS) {
    const resolvedPath = resolveManagedPath(configRoot, target.key ? envConfig[target.key] : undefined, target.fallback);
    if (!resolvedPath) {
      continue;
    }

    if (pathsEqual(resolvedPath, configRoot)) {
      skipped.push(`${resolvedPath} (runtime root is never removed)`);
      continue;
    }

    if (!isWithinPath(resolvedPath, configRoot)) {
      skipped.push(`${resolvedPath} (outside runtime root)`);
      continue;
    }

    if (removeEntryIfExists(resolvedPath)) {
      removed.push(resolvedPath);
    }
  }

  if (removeEntryIfExists(envPath)) {
    removed.push(envPath);
  }

  const dataDir = path.join(configRoot, "data");
  if (removeDirectoryIfEmpty(dataDir)) {
    removed.push(dataDir);
  }

  if (options.removeRuntimeRootIfEmpty && removeDirectoryIfEmpty(configRoot)) {
    removed.push(configRoot);
  }

  return { removed, skipped };
}

function purgeSourcePreparedState(options = {}) {
  const installRoot = options.installRoot;
  const removed = [];
  const skipped = [];

  for (const target of DEFAULT_SOURCE_PREPARED_PURGE_TARGETS) {
    const resolvedPath = resolveManagedPath(installRoot, undefined, target.fallback);
    if (!resolvedPath) {
      continue;
    }

    if (pathsEqual(resolvedPath, installRoot)) {
      skipped.push(`${resolvedPath} (install root is never removed)`);
      continue;
    }

    if (!isWithinPath(resolvedPath, installRoot)) {
      skipped.push(`${resolvedPath} (outside install root)`);
      continue;
    }

    if (removeEntryIfExists(resolvedPath)) {
      removed.push(resolvedPath);
    }
  }

  return { removed, skipped };
}

export function installCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const launcherPath = options.launcherPath || getDefaultLauncherPath(options.wrapperKind);

  if (isWindows(platform)) {
    const installDir = options.installDir || getWindowsInstallDir(env, homeDir);
    mkdirSync(installDir, { recursive: true });
    const cmdPath = path.join(installDir, "strada.cmd");
    const ps1Path = path.join(installDir, "strada.ps1");
    writeTextFile(cmdPath, buildCmdWrapper());
    writeTextFile(ps1Path, buildPowerShellWrapper());

    let pathResult = { updated: false, path: env.PATH || env.Path || "" };
    let pathSyncFailed = false;
    try {
      const syncWindowsPath = options.windowsPathSync || defaultWindowsPathSync;
      pathResult = syncWindowsPath(installDir);
    } catch {
      pathSyncFailed = true;
    }

    console.log("Installed user-local Strada commands:");
    console.log(`  ${cmdPath}`);
    console.log(`  ${ps1Path}`);
    if (pathSyncFailed) {
      console.log("Could not update the Windows user PATH automatically.");
      console.log("Add this directory to your user PATH manually:");
      console.log(`  ${installDir}`);
    } else if (pathResult.updated) {
      console.log("Updated Windows user PATH:");
      console.log(`  ${installDir}`);
    } else {
      console.log("Windows user PATH already contains the Strada install directory:");
      console.log(`  ${installDir}`);
    }

    const currentPath = [env.PATH || "", env.Path || ""].filter(Boolean).join(";");
    if (!hasWindowsPathEntry(currentPath, installDir)) {
      console.log("");
      console.log("Open a new PowerShell or Command Prompt window to pick up the new PATH automatically.");
      console.log("If you want it in this session immediately, run:");
      console.log(`  PowerShell: $env:PATH = "${installDir};$env:PATH"`);
      console.log(`  CMD:        set PATH=${installDir};%PATH%`);
    }

    console.log("");
    console.log("You can keep using this checkout immediately without changing directories:");
    console.log(`  ${launcherPath} setup`);
    console.log(`  ${launcherPath} doctor`);
    return;
  }

  const installDir = options.installDir || getPosixInstallDir(env, homeDir);
  mkdirSync(installDir, { recursive: true });
  const wrapperPath = path.join(installDir, "strada");
  const aliasPath = path.join(installDir, "strada-brain");
  writeTextFile(wrapperPath, buildPosixWrapper({ wrapperPath }), 0o755);
  writeTextFile(aliasPath, buildPosixWrapper({ wrapperPath: aliasPath }), 0o755);

  const { shellName, profilePath } = detectProfilePath(env, homeDir);
  const profileUpdated = appendManagedPathBlock(profilePath, installDir, shellName);

  console.log("Installed user-local Strada commands:");
  console.log(`  ${wrapperPath}`);
  console.log(`  ${aliasPath}`);
  if (profileUpdated) {
    console.log("Updated shell profile:");
    console.log(`  ${profilePath}`);
  } else {
    console.log("Shell profile already contains the Strada PATH entry:");
    console.log(`  ${profilePath}`);
  }

  const pathEntries = String(env.PATH || "").split(":");
  if (!pathEntries.includes(installDir)) {
    console.log("");
    console.log("Open a new terminal to pick up the new PATH automatically.");
    console.log("If you want it in this shell immediately, run:");
    if (shellName === "fish") {
      console.log(`  source "${profilePath}"`);
    } else {
      console.log(`  . "${profilePath}"`);
    }
  }

  console.log("");
  console.log("You can keep using this checkout immediately without changing directories:");
  console.log(`  ${launcherPath} setup`);
  console.log(`  ${launcherPath} doctor`);
}

export function refreshInstalledCommandBindings(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const launcherPath = options.launcherPath || env.STRADA_LAUNCHER_PATH;

  if (!launcherPath) {
    return false;
  }

  if (isWindows(platform)) {
    const installDir = options.installDir || getWindowsInstallDir(env, homeDir);
    const cmdPath = path.join(installDir, "strada.cmd");
    const ps1Path = path.join(installDir, "strada.ps1");
    const launchedFromInstalledWrapper = pathsEqual(launcherPath, cmdPath, platform)
      || pathsEqual(launcherPath, ps1Path, platform);

    if (!launchedFromInstalledWrapper) {
      return false;
    }

    mkdirSync(installDir, { recursive: true });
    writeTextFile(cmdPath, buildCmdWrapper());
    writeTextFile(ps1Path, buildPowerShellWrapper());
    return true;
  }

  const installDir = options.installDir || getPosixInstallDir(env, homeDir);
  const wrapperPath = path.join(installDir, "strada");
  const aliasPath = path.join(installDir, "strada-brain");
  const launchedFromInstalledWrapper = pathsEqual(launcherPath, wrapperPath, platform)
    || pathsEqual(launcherPath, aliasPath, platform);

  if (!launchedFromInstalledWrapper) {
    return false;
  }

  mkdirSync(installDir, { recursive: true });
  writeTextFile(wrapperPath, buildPosixWrapper({ wrapperPath }), 0o755);
  writeTextFile(aliasPath, buildPosixWrapper({ wrapperPath: aliasPath }), 0o755);
  return true;
}

export function uninstallCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const purgeConfig = options.purgeConfig === true;
  const launcherPath = options.launcherPath
    || env.STRADA_LAUNCHER_PATH
    || getDefaultLauncherPath(options.wrapperKind);
  const runtimeRoots = resolveRuntimeRoots({
    platform,
    env,
    homeDir,
    rootDir: options.rootDir || ROOT_DIR,
    sourceCheckout: options.sourceCheckout,
    cwd: options.cwd || resolveLaunchCwd(env, homeDir),
  });
  const removed = [];
  const skipped = [];

  if (isWindows(platform)) {
    const installDir = options.installDir || getWindowsInstallDir(env, homeDir);
    const cmdPath = path.join(installDir, "strada.cmd");
    const ps1Path = path.join(installDir, "strada.ps1");
    const deferredTargets = [];
    for (const targetPath of [cmdPath, ps1Path]) {
      if (!existsSync(targetPath)) {
        continue;
      }
      if (launcherPath && pathsEqual(launcherPath, targetPath, platform)) {
        deferredTargets.push(targetPath);
        continue;
      }
      if (removeEntryIfExists(targetPath)) {
        removed.push(targetPath);
      }
    }
    if (deferredTargets.length > 0) {
      try {
        const scheduleWindowsDeferredDelete =
          options.windowsDeferredDelete || defaultWindowsDeferredDelete;
        if (scheduleWindowsDeferredDelete(deferredTargets, installDir)) {
          for (const targetPath of deferredTargets) {
            removed.push(`${targetPath} (scheduled for deletion after process exit)`);
          }
        } else {
          skipped.push(
            `Could not schedule deletion of active Windows launcher(s) under ${installDir}`,
          );
        }
      } catch {
        skipped.push(`Could not schedule deletion of active Windows launcher(s) under ${installDir}`);
      }
    } else {
      removeDirectoryIfEmpty(installDir);
    }

    let pathResult = { updated: false, path: env.PATH || env.Path || "" };
    try {
      const syncWindowsPath = options.windowsPathRemoveSync || defaultWindowsPathRemoveSync;
      pathResult = syncWindowsPath(installDir);
    } catch {
      skipped.push(`Could not update Windows user PATH for ${installDir}`);
    }
    if (pathResult.updated) {
      removed.push(`PATH:${installDir}`);
    }
  } else {
    const installDir = options.installDir || getPosixInstallDir(env, homeDir);
    const wrapperPath = path.join(installDir, "strada");
    const aliasPath = path.join(installDir, "strada-brain");
    if (removeEntryIfExists(wrapperPath)) {
      removed.push(wrapperPath);
    }
    if (removeEntryIfExists(aliasPath)) {
      removed.push(aliasPath);
    }
    removeDirectoryIfEmpty(installDir);

    for (const profilePath of getManagedProfilePaths(env, homeDir)) {
      if (removeManagedPathBlock(profilePath)) {
        removed.push(profilePath);
      }
    }
  }

  if (purgeConfig) {
    const purgeResult = purgeRuntimeState({
      configRoot: runtimeRoots.configRoot,
      removeRuntimeRootIfEmpty: !runtimeRoots.sourceCheckout,
    });
    removed.push(...purgeResult.removed);
    skipped.push(...purgeResult.skipped);
    if (runtimeRoots.sourceCheckout) {
      const sourcePreparedResult = purgeSourcePreparedState({ installRoot: runtimeRoots.installRoot });
      removed.push(...sourcePreparedResult.removed);
      skipped.push(...sourcePreparedResult.skipped);
    }
  }

  console.log("Removed Strada user-local command bindings.");
  if (removed.length > 0) {
    console.log("Removed:");
    for (const item of removed) {
      console.log(`  ${item}`);
    }
  } else {
    console.log("No installed user-local command bindings were found.");
  }

  if (skipped.length > 0) {
    console.log("Skipped:");
    for (const item of skipped) {
      console.log(`  ${item}`);
    }
  }

  if (purgeConfig) {
    console.log("");
    console.log(`Strada runtime files under ${runtimeRoots.configRoot} were purged.`);
    if (runtimeRoots.sourceCheckout) {
      console.log("Generated source-checkout dependencies and build artifacts were also removed for a zero-install rerun.");
    }
  }

  console.log("The repository checkout itself was not deleted.");
  return { removed, skipped };
}

export function shouldRunFromSource(args) {
  if (!args.length) {
    return true;
  }

  return args.some((arg) => [
    "start",
    "cli",
    "setup",
    "doctor",
    "update",
    "version-info",
    "--help",
    "-h",
    "--version",
    "-V",
    "--web",
    "--terminal",
  ].includes(arg));
}

export function requiresPreparedSourceCheckout(args) {
  if (args.length === 0) {
    return true;
  }

  if (args.includes("--web")) {
    return true;
  }

  if (args[0] === "setup") {
    return !args.includes("--terminal");
  }

  if (args[0] === "start") {
    const channelFlagIndex = args.indexOf("--channel");
    if (channelFlagIndex === -1) {
      return true;
    }
    const requestedChannel = args[channelFlagIndex + 1];
    return !requestedChannel || requestedChannel === "web";
  }

  return false;
}

function parseCliArgs(argv) {
  let wrapperKind = null;
  let wrapperPath = null;
  const args = [...argv];
  while (args.length > 0) {
    const head = args[0];
    if (head === "--wrapper-kind") {
      args.shift();
      wrapperKind = args.shift() || null;
      continue;
    }
    if (head === "--wrapper-path") {
      args.shift();
      wrapperPath = args.shift() || null;
      continue;
    }
    break;
  }
  return { wrapperKind, wrapperPath, userArgs: args };
}

function runNode(entryArgs, extraEnv = {}) {
  const launchCwd = resolveLaunchCwd(process.env, ROOT_DIR);
  const result = spawnSync(process.execPath, entryArgs, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      STRADA_NODE_PATH: process.execPath,
      [STRADA_LAUNCH_CWD_ENV]: launchCwd,
      ...extraEnv,
    },
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

export function main(argv = process.argv.slice(2)) {
  const { wrapperKind, wrapperPath, userArgs } = parseCliArgs(argv);
  const launcherKind = wrapperKind || (isWindows() ? "powershell" : "posix");
  const resolvedLauncherPath = wrapperPath || getDefaultLauncherPath(launcherKind);

  if (userArgs[0] === "install-command") {
    installCommand({
      wrapperKind: launcherKind,
      launcherPath: resolvedLauncherPath,
    });
    return;
  }

  if (userArgs[0] === "refresh-command-bindings") {
    refreshInstalledCommandBindings({
      launcherPath: process.env.STRADA_LAUNCHER_PATH || resolvedLauncherPath,
    });
    return;
  }

  if (userArgs[0] === "uninstall-command" || userArgs[0] === "uninstall") {
    const purgeConfig = userArgs.includes("--purge-config");
    uninstallCommand({
      wrapperKind: launcherKind,
      launcherPath: process.env.STRADA_LAUNCHER_PATH || resolvedLauncherPath,
      purgeConfig,
    });
    return;
  }

  if (shouldRunFromSource(userArgs)) {
    if (requiresPreparedSourceCheckout(userArgs)) {
      ensurePrepared();
    } else {
      ensureSourceCheckout();
    }
    runNode(
      ["--import", "tsx", SOURCE_ENTRY, ...userArgs],
      {
        STRADA_INSTALL_ROOT: ROOT_DIR,
        STRADA_SOURCE_CHECKOUT: "true",
        STRADA_LAUNCHER_PATH: resolvedLauncherPath,
      },
    );
    return;
  }

  ensurePrepared();
  runNode(
    [DIST_ENTRY, ...userArgs],
    {
      STRADA_INSTALL_ROOT: ROOT_DIR,
      STRADA_LAUNCHER_PATH: resolvedLauncherPath,
    },
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  main();
}
