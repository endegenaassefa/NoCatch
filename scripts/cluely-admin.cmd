@echo off
rem OpenCluely (Admin) launcher -- double-click entry point for friends.
rem Runs the packaged root-mode launcher with one UAC click.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cluely-admin.ps1" %*
