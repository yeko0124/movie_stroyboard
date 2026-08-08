#!/bin/bash
# 맥/리눅스용 — 서버와 함께 터널을 열어 밖에서도 접속하게 한다.
cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

PY=".venv/bin/python"

if [ ! -x "$PY" ]; then
  echo ""
  echo "  처음 실행이라 준비 중입니다. 1~2분 걸립니다..."
  echo ""

  PYBIN=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
        PYBIN="$candidate"
        break
      fi
    fi
  done

  if [ -z "$PYBIN" ]; then
    echo "  파이썬 3.9 이상을 찾지 못했습니다."
    echo ""
    echo "  터미널에 아래를 붙여넣어 설치하세요:"
    echo "      xcode-select --install"
    echo "  또는 https://www.python.org/downloads/ 에서 받으세요."
    echo ""
    read -r -p "  엔터를 누르면 닫힙니다..."
    exit 1
  fi

  "$PYBIN" -m venv .venv || {
    echo "  준비에 실패했습니다 (venv 생성)."
    read -r -p "  엔터를 누르면 닫힙니다..."
    exit 1
  }
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet -r requirements.txt || {
    echo "  설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요."
    read -r -p "  엔터를 누르면 닫힙니다..."
    exit 1
  }
  echo "  준비 끝."
fi

"$PY" share.py

echo ""
echo "  서버가 꺼졌습니다."
read -r -p "  엔터를 누르면 닫힙니다..."
