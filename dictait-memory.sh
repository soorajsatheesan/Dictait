#!/bin/bash
set -euo pipefail
DICTAIT_PYTHON="$HOME/Library/Application Support/Dictait/runtime/bin/python"
DICTAIT_TOOL="$HOME/Applications/Dictait.app/Contents/Resources/backend/memory_tool.py"
if [[ ! -x "$DICTAIT_PYTHON" || ! -f "$DICTAIT_TOOL" ]]; then
    echo "Run ./install-macos.sh first." >&2
    exit 1
fi
exec "$DICTAIT_PYTHON" -B "$DICTAIT_TOOL" "$@"
