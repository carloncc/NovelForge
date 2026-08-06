@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo ==========================================
echo   NovelForge 启动 / 打包脚本
echo ==========================================
echo.

:menu
echo.
echo 请选择操作:
echo   [1] 启动开发环境 (pnpm tauri dev)
echo   [2] 打包安装程序 (tauri build)
echo   [3] 仅编译,不打包 (tauri build --no-bundle)
echo   [4] 安装依赖 (pnpm install)
echo   [q] 退出
echo.
set /p choice=请输入数字后回车:
if "%choice%"=="1" goto dev
if "%choice%"=="2" goto package
if "%choice%"=="3" goto build
if "%choice%"=="4" goto install
if /i "%choice%"=="q" goto end
echo 无效输入,请重试.
goto menu

:dev
call :check_deps || goto :end
call :ensure_install
echo.
echo 启动开发环境, Ctrl+C 退出...
pnpm tauri dev
goto end

:package
call :check_deps || goto :end
call :ensure_install
echo.
echo 正在打包安装程序...
pnpm tauri build
if errorlevel 1 goto fail
echo.
echo [OK] 打包完成! 产物位于: src-tauri\target\release\bundle\
start "" "src-tauri\target\release\bundle"
goto end

:build
call :check_deps || goto :end
call :ensure_install
echo.
echo 正在编译(不打包)...
pnpm tauri build --no-bundle
if errorlevel 1 goto fail
echo.
echo [OK] 编译完成! exe 位于: src-tauri\target\release\NovelForge.exe
goto end

:install
call :check_deps || goto :end
call :ensure_install
echo.
echo [OK] 依赖安装完成.
goto end

:check_deps
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未找到 pnpm, 请先安装: npm install -g pnpm
    exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未找到 cargo, 请先安装 Rust: https://rustup.rs
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未找到 node, 请先安装 Node.js
    exit /b 1
)
exit /b 0

:ensure_install
if not exist node_modules (
    echo 首次运行, 安装前端依赖...
    call pnpm install
    if errorlevel 1 (
        echo [ERROR] 依赖安装失败.
        exit /b 1
    )
) else (
    echo node_modules 已存在, 跳过安装.
)
exit /b 0

:fail
echo.
echo [ERROR] 执行失败, 请查看上方错误信息.
goto end

:end
echo.
pause
