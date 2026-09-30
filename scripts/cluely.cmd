@echo off
rem cluely.cmd -- Windows entry point for the one-command root exam mode.
rem Thin shim: delegates to scripts\cluely.ps1 so it works from cmd, PowerShell
rem and WSL alike. Add this scripts directory to PATH to type plain `cluely`.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cluely.ps1" %*
exit /b %errorlevel%
