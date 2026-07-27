@echo off
setlocal
cd /d "%~dp0"

REM Batch body stays ASCII on purpose - Korean text is printed by Python.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title Storyboard Server (shared)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   [1/2] First run - setting up. This takes a minute or two...
  echo.
  python -m venv .venv
  if errorlevel 1 (
    echo.
    echo   Python not found.
    echo   Install it from https://www.python.org/downloads/
    echo   and TICK "Add python.exe to PATH" during setup.
    echo.
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
  echo   [2/2] Done. Starting...
)

".venv\Scripts\python.exe" share.py

echo.
echo   Server stopped.
pause
