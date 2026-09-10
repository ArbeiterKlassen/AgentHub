@echo off
rem ---------------------------------------------------------------
rem  AgentHub launcher (ASCII only on purpose: cmd.exe parses .bat
rem  with the OEM code page, so Chinese text here would break it.
rem  All Chinese output comes from scripts\start-agenthub.mjs .)
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AgentHub Service  -  Ctrl+C to stop

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 22.5+ .
  echo.
  pause
  exit /b 1
)

node "scripts\start-agenthub.mjs" %*
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo [AgentHub] exited with code %EXITCODE%.
  pause
)
endlocal
exit /b %EXITCODE%
