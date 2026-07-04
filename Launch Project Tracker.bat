@echo off
REM One-press launcher: ensures the backend is running (starts it only if it's
REM down), waits for it, then opens the Project Tracker in Microsoft Edge.
REM Safe to run any number of times. This is what the desktop shortcut points at.
cd /d "%~dp0"

REM 1) Start the launcher backend ONLY if :7795 isn't already listening, then wait for it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(-not(Get-NetTCPConnection -State Listen -LocalPort 7795 -ErrorAction SilentlyContinue)){Start-Process node -ArgumentList 'launcher-server.js' -WorkingDirectory '%~dp0' -WindowStyle Minimized}; for($i=0;$i -lt 40;$i++){if(Get-NetTCPConnection -State Listen -LocalPort 7795 -ErrorAction SilentlyContinue){break}; Start-Sleep -Milliseconds 250}"

REM 2) Open the tracker in Microsoft Edge (msedge resolves via Windows App Paths).
start "" msedge "http://127.0.0.1:7795/"
