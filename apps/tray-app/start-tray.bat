@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Agent Vibes 托盘应用...
echo.

:: 检查 protocol-bridge 是否已构建
if not exist "..\protocol-bridge\dist\main.js" (
    echo 错误: protocol-bridge 未构建
    echo 请先运行: cd apps/protocol-bridge ^&^& npm run build
    pause
    exit /b 1
)

:: 使用 npx 运行 electron
npx electron dist/main.js
