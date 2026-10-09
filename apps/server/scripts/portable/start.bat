@echo off
chcp 65001 >nul
title 百工工作室（便携版）
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0launcher.mjs"
if errorlevel 1 pause
