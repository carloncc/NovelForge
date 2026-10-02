@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo ==========================================
echo   NovelForge launcher / packaging script
echo ==========================================
echo.

:menu
echo.
echo Choose an action:
echo   [1] Start dev environment (pnpm tauri dev)
echo   [2] Package installer (tauri build)
echo   [3] Compile only, no bundle (tauri build --no-bundle)
echo   [4] Install dependencies (pnpm install)
echo   [q] Quit
echo.
set /p choice=Enter a number and press Enter: 
if "%choice%"=="1" goto dev
if "%choice%"=="2" goto package
if "%choice%"=="3" goto build
if "%choice%"=="4" goto install
if /i "%choice%"=="q" goto end
echo Invalid input, please try again.
goto menu

:dev
call :check_deps || goto :end
call :ensure_install
echo.
echo Starting dev environment, press Ctrl+C to exit...
pnpm tauri dev
goto end

:package
call :check_deps || goto :end
call :ensure_install
echo.
echo Packaging installer...
pnpm tauri build
if errorlevel 1 goto fail
echo.
echo [OK] Package complete. Artifacts: src-tauri\target\release\bundle\
start "" "src-tauri\target\release\bundle"
goto end

:build
call :check_deps || goto :end
call :ensure_install
echo.
echo Compiling (no bundle)...
pnpm tauri build --no-bundle
if errorlevel 1 goto fail
echo.
echo [OK] Compile complete. exe: src-tauri\target\release\NovelForge.exe
goto end

:install
call :check_deps || goto :end
call :ensure_install
echo.
echo [OK] Dependencies installed.
goto end

:check_deps
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] pnpm not found. Install it first: npm install -g pnpm
    exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] cargo not found. Install Rust first: https://rustup.rs
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found. Install Node.js first.
    exit /b 1
)
exit /b 0

:ensure_install
if not exist node_modules (
    echo First run: installing frontend dependencies...
    call pnpm install
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        exit /b 1
    )
) else (
    echo node_modules found, skipping install.
)
exit /b 0

:fail
echo.
echo [ERROR] Command failed. See the error output above.
goto end

:end
echo.
pause
