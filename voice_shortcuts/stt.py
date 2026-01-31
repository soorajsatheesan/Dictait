"""Speech-to-text with Whisper (medium by default)."""
import os
import tempfile
import wave
from voice_shortcuts.config import WHISPER_MODEL

_model = None


def load_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


def transcribe(raw_pcm_bytes):
    """Transcribe 16 kHz mono 16-bit PCM. Returns trimmed text or empty string."""
    if not raw_pcm_bytes:
        return ""
    try:
        model = load_model()
    except ImportError:
        return ""
    fd, path = tempfile.mkstemp(suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as f:
            with wave.open(f, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(raw_pcm_bytes)
        segments, _ = model.transcribe(path, language="en", beam_size=1, vad_filter=True)
        return " ".join(s.text for s in segments if s.text).strip() or ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
