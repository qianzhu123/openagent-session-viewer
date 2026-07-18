#!/usr/bin/env bash
# OpenAgent Session Viewer launcher (Unix/Linux/macOS). Pure stdlib, no third-party deps.
set -e
cd "$(dirname "$0")"

VENV=".venv"
PORT="${PORT:-8092}"

if [ ! -x "$VENV/bin/python" ]; then
    echo "[setup] creating local venv .venv ..."
    python3 -m venv "$VENV" 2>/dev/null || python -m venv "$VENV"
    if [ -f requirements.txt ]; then
        "$VENV/bin/python" -m pip install -q -r requirements.txt
    fi
fi

echo "[run] OpenAgent Session Viewer -> http://127.0.0.1:$PORT"
"$VENV/bin/python" server.py --port "$PORT" --open
