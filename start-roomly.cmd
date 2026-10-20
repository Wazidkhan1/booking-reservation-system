@echo off
setlocal
cd /d "%~dp0"
title Roomly - Booking and Reservation System
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer, then run this launcher again.
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  call npm.cmd install
  if errorlevel 1 goto failed
)
call npm.cmd run setup
if errorlevel 1 goto failed
echo.
echo Open the URL printed below in your browser. Leave this window open.
echo Press Ctrl+C to stop the web server.
echo.
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Roomly could not start. See the message above and README.md.
pause
exit /b 1
