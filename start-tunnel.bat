@echo off
rem ---------------------------------------------------------------
rem  Start the Cloudflare Tunnel for AgentHub (ASCII only: cmd.exe
rem  parses .bat with the OEM code page, Chinese text would break it).
rem
rem  Public URL: https://agenthub.soyorin.work  ->  https://127.0.0.1:8787
rem  Press Ctrl+C in this window to stop the tunnel.
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AgentHub Tunnel  -  Ctrl+C to stop

rem Locate cloudflared: env override -> PATH -> <repo>\..\tools\cloudflared\
if defined CLOUDFLARED set "CF=%CLOUDFLARED%"
if not defined CF (
  where cloudflared >nul 2>nul
  if not errorlevel 1 (set "CF=cloudflared") else (set "CF=%~dp0..\tools\cloudflared\cloudflared.exe")
)
set "CFG=%~dp0data\cloudflared\config.yml"

if not "%CF%"=="cloudflared" if not exist "%CF%" (
  echo [ERROR] cloudflared.exe not found: %CF%
  echo         Install it ^(winget install Cloudflare.cloudflared^) or download from
  echo         https://github.com/cloudflare/cloudflared/releases and set CLOUDFLARED to its path.
  echo.
  pause
  exit /b 1
)

if not exist "%CFG%" (
  echo [ERROR] config not found: %CFG%
  echo.
  pause
  exit /b 1
)

echo.
echo   AgentHub tunnel
echo   public : https://agenthub.soyorin.work
echo   origin : https://127.0.0.1:8787
echo.
echo   Ctrl+C to stop.  (The AgentHub server itself must be running too.)
echo.

"%CF%" --config "%CFG%" tunnel run
set EXITCODE=%errorlevel%

echo.
echo [tunnel] exited with code %EXITCODE%
pause
endlocal
exit /b %EXITCODE%
