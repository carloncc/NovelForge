@echo off
rem ============================================================================
rem  NovelForge promo demo launcher
rem
rem  IMPORTANT: this file is intentionally ASCII-only.
rem  cmd.exe mis-parses .bat files that contain multi-byte UTF-8 text (it re-reads
rem  the file at byte offsets computed under a different code page, so Chinese
rem  lines get executed as commands). Verified on this machine: even a UTF-8 BOM
rem  does not fix it. Chinese user-facing text therefore lives in notice.txt,
rem  which is printed with `type` after `chcp 65001`.
rem
rem  Python on this machine is broken (missing Lib dir), so `python -m http.server`
rem  cannot be used; the static server is serve.cjs (Node, zero dependencies).
rem ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NF_NOTICE=%~dp0notice.txt"
set "NF_TITLE=NovelForge promo demo server"

if not exist "serve.cjs" goto :no_serve
if not exist "index.html" goto :no_index
where node >nul 2>nul
if errorlevel 1 goto :no_node

echo.
echo   NovelForge promo demo - starting local static server ...
echo.
start "%NF_TITLE%" cmd /k node "%~dp0serve.cjs"

rem Portable ~2s sleep: `timeout` aborts when stdin is redirected, `ping` does not.
ping -n 3 127.0.0.1 >nul

start "" "http://127.0.0.1:8080/"

echo   Opened http://127.0.0.1:8080/ in your default browser.
echo.
echo   To stop the server: close the "%NF_TITLE%" window, or press Ctrl+C there.
echo.
echo   IMPORTANT: do NOT double-click index.html. The WebGAL engine entry is a
echo   module script; under file:// it is blocked by CORS and the engine shows
echo   "cannot open this game by double-clicking" instead. Always use the
echo   http://127.0.0.1:8080/ address above.
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0

:no_serve
echo.
echo   [ERROR] serve.cjs was not found next to this launcher.
type "%NF_NOTICE%"
pause
exit /b 1

:no_index
echo.
echo   [NOTICE] index.html was not found in this folder - the game has not been
echo            assembled here yet.
type "%NF_NOTICE%"
pause
exit /b 1

:no_node
echo.
echo   [ERROR] Node.js was not found on PATH.
type "%NF_NOTICE%"
pause
exit /b 1
