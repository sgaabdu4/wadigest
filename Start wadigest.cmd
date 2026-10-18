@echo off
rem Windows: double-click to install (first time) and open wadigest.
cd /d "%~dp0"
if exist "%USERPROFILE%\.wadigest\bin\wadigest.cmd" (
  call "%USERPROFILE%\.wadigest\bin\wadigest.cmd"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
)
