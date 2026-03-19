@echo off
setlocal
if defined STRADA_NODE_PATH (
  set "NODE_EXE=%STRADA_NODE_PATH%"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Strada requires Node.js 20+.
    echo Install Node.js, then run strada.cmd again.
    exit /b 1
  )
  set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo Strada requires Node.js 20+.
  echo Install Node.js, then run strada.cmd again.
  exit /b 1
)

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "SOURCE_LAUNCHER=%ROOT_DIR%\scripts\source-launcher.mjs"
"%NODE_EXE%" "%SOURCE_LAUNCHER%" --wrapper-kind cmd --wrapper-path "%~f0" %*
exit /b %ERRORLEVEL%
