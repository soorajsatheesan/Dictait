#!/bin/bash
set -euo pipefail

# Locate Dictait.app in /Applications (DMG / install.sh) or ~/Applications (source build).
APP=""
for candidate in "/Applications/Dictait.app" "$HOME/Applications/Dictait.app"; do
    if [[ -d "$candidate" ]]; then
        APP="$candidate"
        break
    fi
done

DICTAIT_TOOL="${APP:+$APP/Contents/Resources/backend/memory_tool.py}"
if [[ -z "$DICTAIT_TOOL" || ! -f "$DICTAIT_TOOL" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    DICTAIT_TOOL="$SCRIPT_DIR/macos/backend/memory_tool.py"
fi

# Prefer the Python bundled inside the app, then fall back to the source-build runtime venv.
DICTAIT_PYTHON=""
for py in \
    "${APP:+$APP/Contents/Resources/python/bin/python3}" \
    "$HOME/Library/Application Support/Dictait/runtime/bin/python" \
    "$(command -v python3 || true)"; do
    if [[ -n "$py" && -x "$py" ]]; then
        DICTAIT_PYTHON="$py"
        break
    fi
done

if [[ -z "$DICTAIT_PYTHON" || ! -f "$DICTAIT_TOOL" ]]; then
    echo "Dictait is not installed yet. Install Dictait.app into /Applications or run ./install-macos.sh." >&2
    exit 1
fi
exec "$DICTAIT_PYTHON" -B "$DICTAIT_TOOL" "$@"
