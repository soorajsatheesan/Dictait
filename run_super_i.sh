#!/bin/bash
# Bind to Super+I in GNOME Keyboard Shortcuts (Wayland).
# First press: start listening. Second press: stop, transcribe (Whisper medium), copy to clipboard.
DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$DIR/venv/bin/python3"
[ -x "$PY" ] || PY=python3
exec "$PY" "$DIR/voice_toggle.py"
