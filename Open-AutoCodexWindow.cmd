@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-AutoCodexWindow.ps1" %*
if errorlevel 1 pause
