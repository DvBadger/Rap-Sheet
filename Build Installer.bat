@echo off
setlocal
cd /d "%~dp0"
title Rap Sheet - build installer
echo.
echo  Building the Rap Sheet installer. This takes a few minutes and needs internet.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Installing it now through Windows Package Manager...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo  Node.js was installed. Close this window and double-click "Build Installer.bat" again.
  pause
  exit /b 0
)
call npm install
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo  Done. Your installer is in the "release" folder: RapSheet-Setup-...exe
echo  Upload that one file to Google Drive and share the link.
start "" "%~dp0release"
pause
exit /b 0
:fail
echo.
echo  Something failed. Copy the text above and send it to me.
pause
exit /b 1
