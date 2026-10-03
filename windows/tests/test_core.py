from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave
from windows.core import SpeechEngine


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = SpeechEngine(self.temp.name)

    def test_invalid_saved_model_falls_back(self):
        settings = Path(self.temp.name) / "settings.json"
        for contents in ('{"model": "../../outside"}', 'null', '[]', 'invalid'):
            settings.write_text(contents)
            self.assertEqual(self.engine.saved_model(), "small")

    def test_partial_model_is_not_ready(self):
        path = self.engine.model_path("small")
        path.mkdir(parents=True)
        (path / "model.bin").touch()
        self.assertFalse(self.engine.is_downloaded("small"))
        with self.assertRaises(FileNotFoundError):
            self.engine.prepare("small")

    def test_cached_model_load_uses_local_path(self):
        path = self.engine.model_path("base")
        path.mkdir(parents=True)
        for name in ("model.bin", "config.json", "tokenizer.json"):
            (path / name).touch()
        module = SimpleNamespace(WhisperModel=Mock())
        with patch.dict("sys.modules", {"faster_whisper": module}):
            self.engine.prepare("base")
        module.WhisperModel.assert_called_once_with(str(path), device="cpu", compute_type="int8")
        self.assertEqual(self.engine.saved_model(), "base")

    def test_wav_deleted_after_lazy_transcription_failure(self):
        seen = []
        def transcribe(filename, **kwargs):
            seen.append(filename)
            with wave.open(filename) as audio:
                self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 16000))
            def segments():
                yield SimpleNamespace(text="first")
                raise RuntimeError("decoder failed")
            return segments(), None
        self.engine.model = SimpleNamespace(transcribe=transcribe)
        with self.assertRaises(RuntimeError):
            self.engine.transcribe(b"\x00\x00" * 160)
        self.assertFalse(Path(seen[0]).exists())

    def test_transcription_preserves_words_and_deletes_audio(self):
        self.engine.model = Mock()
        self.engine.model.transcribe.return_value = (iter([SimpleNamespace(text=" Hello "), SimpleNamespace(text=""), SimpleNamespace(text="world. ")]), None)
        self.assertEqual(self.engine.transcribe(b"\x00\x00" * 160), "Hello world.")
        self.assertEqual(list(Path(self.temp.name).glob("recording-*.wav")), [])

    def test_model_path_rejects_unknown_names(self):
        with self.assertRaises(ValueError):
            self.engine.model_path("../../outside")


if __name__ == "__main__":
    unittest.main()
