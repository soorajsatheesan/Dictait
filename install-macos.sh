#!/bin/bash
# One command installs the runtime, prepares local models, builds and opens Dictait.
set -euo pipefail
DICTAIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DICTAIT_OPEN=true
DICTAIT_PREPARE=true
for option in "$@"; do
    case "$option" in
        --no-open) DICTAIT_OPEN=false ;;
        --skip-models) DICTAIT_PREPARE=false ;;
        --help) echo "Usage: ./install-macos.sh [--no-open] [--skip-models]"; exit 0 ;;
        *) echo "Unknown option: $option" >&2; exit 1 ;;
    esac
done
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    echo "Use this installer on an Apple Silicon Mac. Linux setup is in README.md." >&2
    exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
    echo "Install Apple Command Line Tools first: xcode-select --install" >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    echo "Install Node.js 20 or later to build the app (https://nodejs.org or: brew install node), then rerun." >&2
    exit 1
fi
DICTAIT_PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
       "$candidate" -c 'import sys, platform; assert (3, 11) <= sys.version_info[:2] < (3, 14); assert platform.machine() == "arm64"' >/dev/null 2>&1; then
        DICTAIT_PYTHON="$(command -v "$candidate")"
        break
    fi
done
if [[ -z "$DICTAIT_PYTHON" ]]; then
    echo "Install native Apple Silicon Python 3.11–3.13, then rerun. With Homebrew: brew install python@3.12" >&2
    exit 1
fi
DICTAIT_SUPPORT="$HOME/Library/Application Support/Dictait"
DICTAIT_RUNTIME="$DICTAIT_SUPPORT/runtime"
mkdir -p "$DICTAIT_SUPPORT" "$HOME/Applications"
if [[ ! -x "$DICTAIT_RUNTIME/bin/python" ]]; then
    "$DICTAIT_PYTHON" -m venv "$DICTAIT_RUNTIME"
fi
"$DICTAIT_RUNTIME/bin/python" -m pip install -r "$DICTAIT_ROOT/macos/requirements.txt"
if $DICTAIT_PREPARE; then
    echo "Preparing Whisper Turbo and Qwen. Models download once; later runs use the local cache."
    HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 TOKENIZERS_PARALLELISM=false \
        "$DICTAIT_RUNTIME/bin/python" -u "$DICTAIT_ROOT/macos/backend/worker.py" --prepare
fi
"$DICTAIT_ROOT/build-macos.sh"
if pgrep -x Dictait >/dev/null 2>&1; then
    pkill -TERM -x Dictait
    for attempt in 1 2 3 4 5; do
        if ! pgrep -x Dictait >/dev/null 2>&1; then break; fi
        sleep 1
    done
    if pgrep -x Dictait >/dev/null 2>&1; then
        echo "Quit the running Dictait app, then rerun this installer." >&2
        exit 1
    fi
fi
DICTAIT_STAGING="$HOME/Applications/.Dictait-install-$$.app"
DICTAIT_BACKUP="$HOME/Applications/.Dictait-backup-$$.app"
trap 'rm -rf "$DICTAIT_STAGING"' EXIT
ditto "$DICTAIT_ROOT/dist/Dictait.app" "$DICTAIT_STAGING"
codesign --verify --strict "$DICTAIT_STAGING"
if [[ -d "$HOME/Applications/Dictait.app" ]]; then
    mv "$HOME/Applications/Dictait.app" "$DICTAIT_BACKUP"
fi
if ! mv "$DICTAIT_STAGING" "$HOME/Applications/Dictait.app"; then
    if [[ -d "$DICTAIT_BACKUP" ]]; then mv "$DICTAIT_BACKUP" "$HOME/Applications/Dictait.app"; fi
    exit 1
fi
if [[ -d "$DICTAIT_BACKUP" ]]; then rm -rf "$DICTAIT_BACKUP"; fi
echo "Installed $HOME/Applications/Dictait.app"
echo "Control–Space starts and stops dictation. Launch at login is enabled on first launch."
if $DICTAIT_OPEN; then open "$HOME/Applications/Dictait.app"; fi
