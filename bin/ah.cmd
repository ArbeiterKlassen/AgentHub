@echo off
rem AgentHub CLI launcher (Windows). Works from any working directory.
rem Put this folder on PATH so `ah ...` works without any path prefix.
rem Chinese message bodies: use --body-file, not a command-line argument.
setlocal
set "AH_ROOT=%~dp0.."
node "%AH_ROOT%\server\bin\ah.mjs" %*
