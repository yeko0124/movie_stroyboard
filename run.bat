@echo off
setlocal
cd /d "%~dp0"

REM 배치 파일 본문은 코드페이지를 타므로 여기 메시지는 영문으로 둔다.
REM 한글 안내는 main.py 가 UTF-8 로 출력한다.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title Storyboard Server

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

".venv\Scripts\python.exe" main.py

echo.
echo   Server stopped.
pause
