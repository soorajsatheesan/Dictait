#!/bin/bash
set -euo pipefail

APP=""
for candidate in "/Applications/Dictait.app" "$HOME/Applications/Dictait.app"; do
    if [[ -d "$candidate" ]]; then
        APP="$candidate"
        break
    fi
done

SERVER="${APP:+$APP/Contents/Resources/backend/mcp_server.py}"
if [[ -z "$SERVER" || ! -f "$SERVER" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    SERVER="$SCRIPT_DIR/macos/backend/mcp_server.py"
fi

PYTHON=""
for py in \
    "${APP:+$APP/Contents/Resources/python/bin/python3}" \
    "$HOME/Library/Application Support/Dictait/runtime/bin/python" \
    "$(command -v python3 || true)"; do
    if [[ -n "$py" && -x "$py" ]]; then
        PYTHON="$py"
        break
    fi
done

if [[ -z "$PYTHON" || ! -f "$SERVER" ]]; then
    echo "Dictait MCP server not found." >&2
    exit 1
fi
exec "$PYTHON" -B -u "$SERVER"
