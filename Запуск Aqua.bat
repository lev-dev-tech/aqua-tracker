@echo off
chcp 65001 >nul
title Aqua - трекер привычек
cd /d "%~dp0"
echo Запускаю Aqua...
node server.js
echo.
echo Сервер остановлен. Нажми любую клавишу для выхода.
pause >nul
