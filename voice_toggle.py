#!/usr/bin/env python3
"""
Super+I once = start listening. Super+I again = stop, transcribe (Whisper medium), copy to clipboard.
Bind this (or run_super_i.sh) to Super+I in GNOME Keyboard Shortcuts for Wayland.
"""
import os
import signal
import subprocess
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from voice_shortcuts.config import PROJECT_ROOT, PID_FILE

VOICE_SCRIPT = PROJECT_ROOT / "voice_shortcut.py"
INTERPRETER = PROJECT_ROOT / "venv" / "bin" / "python3"
if not INTERPRETER.exists():
    INTERPRETER = Path(sys.executable)


def main():
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            PID_FILE.unlink(missing_ok=True)
            return
        except (ValueError, ProcessLookupError, OSError):
            PID_FILE.unlink(missing_ok=True)
    if not VOICE_SCRIPT.exists():
        sys.exit(1)
    subprocess.Popen(
        [str(INTERPRETER), str(VOICE_SCRIPT)],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


if __name__ == "__main__":
    main()
