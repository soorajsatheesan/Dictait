#!/usr/bin/env python3
"""
Super+I once = start listening. Super+I again = stop, transcribe (Whisper medium), copy to clipboard.
Bind this (or run_super_i.sh) to Super+I in GNOME Keyboard Shortcuts for Wayland.
"""
import os
import json
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


def _read_pid():
    try:
        raw = PID_FILE.read_text().strip()
    except OSError:
        return None

    if not raw:
        return None

    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            pid = int(payload.get("pid", 0))
            script = str(payload.get("script", ""))
            return pid, script
    except (json.JSONDecodeError, ValueError, TypeError):
        pass

    try:
        return int(raw), ""
    except ValueError:
        return None


def _is_voice_shortcut_process(pid, expected_script):
    cmdline_path = Path(f"/proc/{pid}/cmdline")
    try:
        cmdline = cmdline_path.read_bytes().decode("utf-8", errors="ignore")
    except OSError:
        return False
    parts = [p for p in cmdline.split("\x00") if p]
    if not parts:
        return False
    if expected_script and expected_script in parts:
        return True
    return any(Path(arg).name == "voice_shortcut.py" for arg in parts)


def main():
    if PID_FILE.exists():
        pid_data = _read_pid()
        if pid_data is None:
            PID_FILE.unlink(missing_ok=True)
        else:
            pid, expected_script = pid_data
            if _is_voice_shortcut_process(pid, expected_script):
                try:
                    os.kill(pid, signal.SIGTERM)
                    PID_FILE.unlink(missing_ok=True)
                    return
                except (ProcessLookupError, OSError):
                    PID_FILE.unlink(missing_ok=True)
            else:
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
