"""Paths and settings."""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = PROJECT_ROOT / "logs"
PID_FILE = PROJECT_ROOT / "voice_listener.pid"

STT_BACKEND = os.environ.get("VOICE_STT_BACKEND", "whisper").strip().lower()
WHISPER_MODEL = os.environ.get("VOICE_WHISPER_MODEL", "medium").strip().lower()
