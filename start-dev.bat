@echo off
chcp 65001 >nul
title SyncFrame Dev
setlocal
set ROOT=%~dp0syncframe-poc

echo [SyncFrame] Starting backend server...
start "SyncFrame Server" cmd /k "cd /d %ROOT% && npm run p1:server"

echo [SyncFrame] Starting web dev server...
start "SyncFrame Web" cmd /k "cd /d %ROOT% && npm run p1:web"

echo [SyncFrame] Both services starting in separate windows.
pause
