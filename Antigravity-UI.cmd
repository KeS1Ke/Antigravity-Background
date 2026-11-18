@echo off
setlocal
chcp 65001 >nul
echo.
echo [1] Install / Update
echo [2] Uninstall
echo [3] Check status
choice /c 123 /n /m "Select 1, 2 or 3: "
if errorlevel 3 (
    node "%~dp0manage.cjs" status
) else if errorlevel 2 (
    node "%~dp0manage.cjs" uninstall
) else if errorlevel 1 (
    node "%~dp0manage.cjs" install
)
echo.
pause
