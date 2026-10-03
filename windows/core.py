"""Local model storage and transcription, independent of the Windows UI."""
import json
import os
from pathlib import Path
import tempfile
import wave

MODELS = {"base": "Base · fastest (~150 MB)", "small": "Small · balanced (~500 MB)",
          "medium": "Medium · more accurate (~1.5 GB)"}
RATE = 16000
MAX_SECONDS = 300


def data_directory():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "Dictait"


class SpeechEngine:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else data_directory()
        self.model = None
        self.model_name = None

    def saved_model(self):
        try:
            name = json.loads((self.directory / "settings.json").read_text()).get("model")
            return name if name in MODELS else "small"
        except (OSError, ValueError, TypeError, AttributeError):
            return "small"

    def model_path(self, name):
        if name not in MODELS:
            raise ValueError("Choose a supported Whisper model.")
        return self.directory / "models" / name

    def is_downloaded(self, name):
        path = self.model_path(name)
        return all((path / filename).is_file() for filename in ("model.bin", "config.json", "tokenizer.json"))

    def prepare(self, name, allow_download=False):
        # A cached model is always opened by path, preventing a hidden network request offline.
        path = self.model_path(name)
        if not self.is_downloaded(name):
            if not allow_download:
                raise FileNotFoundError("Download a voice model in setup first.")
            from faster_whisper.utils import download_model
            download_model(name, output_dir=str(path))
        from faster_whisper import WhisperModel
        model = WhisperModel(str(path), device="cpu", compute_type="int8")
        self.directory.mkdir(parents=True, exist_ok=True)
        settings = self.directory / "settings.json"
        temporary = settings.with_suffix(".tmp")
        temporary.write_text(json.dumps({"model": name}), encoding="utf-8")
        temporary.replace(settings)
        self.model, self.model_name = model, name

    def transcribe(self, pcm):
        if not pcm:
            return ""
        if self.model is None:
            raise RuntimeError("The voice model is not ready.")
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, filename = tempfile.mkstemp(suffix=".wav", prefix="recording-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as output:
                with wave.open(output, "wb") as recording:
                    recording.setnchannels(1)
                    recording.setsampwidth(2)
                    recording.setframerate(RATE)
                    recording.writeframes(pcm)
            segments, _ = self.model.transcribe(filename, beam_size=1, vad_filter=True)
            return " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        finally:
            Path(filename).unlink(missing_ok=True)
