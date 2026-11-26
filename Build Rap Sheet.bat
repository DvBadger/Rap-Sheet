@echo off
cd /d "%~dp0"
echo Rap Sheet - one-time build. Needs Node.js LTS from https://nodejs.org (install it first if this fails).
where node >/dev/null 2>/dev/null || (echo Node.js not found. Install it, then run this again. & pause & exit /b 1)
call npm install
if errorlevel 1 (echo npm install failed & pause & exit /b 1)
call npm run package:win
if errorlevel 1 (echo packaging failed & pause & exit /b 1)
echo.
echo Done. Open the "dist\Rap Sheet-win32-x64" folder and run Rap Sheet.exe
start "" "dist\Rap Sheet-win32-x64"
pause
