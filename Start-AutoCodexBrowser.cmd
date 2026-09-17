@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AutoCodexDesktop.ps1" -Browser %*
if errorlevel 1 pause
