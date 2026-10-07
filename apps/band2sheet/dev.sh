#!/bin/sh
# Run from any directory with app-local Python, data and model caches.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ ! -x .venv/bin/python ]; then
  echo '먼저 apps/band2sheet에서 Python 가상환경과 앱 의존성을 설치하세요 (README.md).' >&2
  exit 1
fi
export BAND2SHEET_DATA="${BAND2SHEET_DATA:-$PWD/.data}"
export BAND2SHEET_MODEL_DIR="${BAND2SHEET_MODEL_DIR:-$PWD/.cache/models}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PWD/.cache}"
export TORCH_HOME="${TORCH_HOME:-$PWD/.cache/torch}"
export HF_HOME="${HF_HOME:-$PWD/.cache/huggingface}"
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-$PWD/.cache/numba}"
exec .venv/bin/python -m band2sheet app --host 127.0.0.1 --port 8765 "$@"
