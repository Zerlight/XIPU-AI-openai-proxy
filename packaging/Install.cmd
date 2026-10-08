@echo off
setlocal DisableDelayedExpansion
"%~dp0xipu-bridge.exe" install %*
set "xipu_status=%errorlevel%"
if not "%xipu_status%"=="0" echo Installation failed. Read the error above.
echo.
if "%~1"=="" pause
exit /b %xipu_status%
