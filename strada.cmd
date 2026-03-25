@echo off
setlocal EnableDelayedExpansion

:: --- Node.js resolution with automatic portable download ---

:: 1. Explicit override
if defined STRADA_NODE_PATH (
  set "NODE_EXE=%STRADA_NODE_PATH%"
  goto :found_node
)

:: 2. System-installed node
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_EXE=node"
  goto :found_node
)

:: 3. Strada-managed portable node
if defined LOCALAPPDATA (
  set "STRADA_NODE_DIR=%LOCALAPPDATA%\Strada\node"
) else (
  set "STRADA_NODE_DIR=%USERPROFILE%\AppData\Local\Strada\node"
)
if exist "%STRADA_NODE_DIR%\node.exe" (
  set "NODE_EXE=%STRADA_NODE_DIR%\node.exe"
  goto :found_node
)

:: 4. Node not found - offer to download portable version
echo.
echo Node.js is not installed on this system.
echo Strada requires Node.js 20+ to run.
echo.
echo Strada can download a portable Node.js automatically.
echo It will be installed to: %STRADA_NODE_DIR%
echo This is a one-time download (~30 MB) and will NOT modify your system PATH.
echo.
set /p "CONFIRM=Download portable Node.js now? [Y/n] "
if /i "%CONFIRM%"=="n" goto :no_node
if /i "%CONFIRM%"=="no" goto :no_node

:: Detect architecture
set "ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "NODE_VERSION=v22.18.0"
set "ZIP_NAME=node-%NODE_VERSION%-win-%ARCH%.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/%ZIP_NAME%"

echo.
echo Downloading Node.js %NODE_VERSION% (%ARCH%)...

set "TEMP_DIR=%TEMP%\strada-node-install"
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"
mkdir "%STRADA_NODE_DIR%" 2>nul

:: Use PowerShell to download and extract (available on all Windows 10+)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP_DIR%\%ZIP_NAME%' -UseBasicParsing; Expand-Archive -Path '%TEMP_DIR%\%ZIP_NAME%' -DestinationPath '%TEMP_DIR%' -Force"

if errorlevel 1 (
  echo.
  echo Failed to download Node.js.
  echo Please install Node.js manually from https://nodejs.org
  if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
  exit /b 1
)

echo Extracting...

set "EXTRACTED=%TEMP_DIR%\node-%NODE_VERSION%-win-%ARCH%"

:: Copy node.exe
copy /y "%EXTRACTED%\node.exe" "%STRADA_NODE_DIR%\node.exe" >nul

:: Copy npm files
for %%F in (npm npm.cmd npx npx.cmd corepack corepack.cmd) do (
  if exist "%EXTRACTED%\%%F" copy /y "%EXTRACTED%\%%F" "%STRADA_NODE_DIR%\%%F" >nul
)

:: Copy node_modules (contains npm)
if exist "%EXTRACTED%\node_modules" (
  xcopy /e /i /q /y "%EXTRACTED%\node_modules" "%STRADA_NODE_DIR%\node_modules" >nul
)

:: Clean up
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"

echo Node.js %NODE_VERSION% installed to %STRADA_NODE_DIR%
echo.

set "NODE_EXE=%STRADA_NODE_DIR%\node.exe"
goto :found_node

:no_node
echo.
echo You can install Node.js manually from https://nodejs.org
echo Or set STRADA_NODE_PATH to point to your node.exe
exit /b 1

:found_node
:: Ensure the directory containing node (and npm) is on PATH for child processes
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "NODE_DIR=%NODE_DIR:~0,-1%"
echo "%PATH%" | findstr /i /c:"%NODE_DIR%" >nul 2>nul
if errorlevel 1 set "PATH=%NODE_DIR%;%PATH%"
set "STRADA_NODE_PATH=%NODE_EXE%"

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "SOURCE_LAUNCHER=%ROOT_DIR%\scripts\source-launcher.mjs"
"%NODE_EXE%" "%SOURCE_LAUNCHER%" --wrapper-kind cmd --wrapper-path "%~f0" %*
exit /b %ERRORLEVEL%
