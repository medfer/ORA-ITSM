@echo off
REM ORA ITSM - Windows launcher (requires Node.js 22 or later: https://nodejs.org)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
echo.
echo  ORA ITSM is starting on http://localhost:8080
echo  Keep this window open. Close it (or press Ctrl+C) to stop the application.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8080"
call npm start
pause
