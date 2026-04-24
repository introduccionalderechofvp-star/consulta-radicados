@echo off
setlocal
cd /d "%~dp0"
title Consulta de radicados - Rama Judicial

echo.
echo   ============================================
echo     Consulta de radicados - Rama Judicial
echo   ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js no esta instalado o no esta en el PATH.
    echo   Descargalo desde https://nodejs.org/ y vuelve a ejecutar.
    echo.
    pause
    exit /b 1
)

if not exist node_modules\ (
    echo   Primera vez: instalando dependencias de Node...
    call npm install
    if errorlevel 1 (
        echo   Fallo npm install.
        pause
        exit /b 1
    )
    echo.
    echo   Descargando Chromium para Playwright (unos 150 MB)...
    call npx playwright install chromium
    echo.
)

echo   Iniciando consulta. El proceso tarda ~1 hora para los 97 radicados.
echo   No apagues ni suspendas el computador mientras corre.
echo.

node consultar.js

echo.
echo   ============================================
echo     Terminado. Revisa la carpeta resultados\.
echo   ============================================
echo.
pause
