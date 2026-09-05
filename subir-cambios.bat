@echo off
setlocal

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0subir-cambios.ps1" %*

echo.
echo Presiona una tecla para cerrar esta ventana...
pause >nul