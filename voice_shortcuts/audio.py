"""Microphone capture via PyAudio."""
import pyaudio

CHUNK = 1024
RATE = 16000
FORMAT = pyaudio.paInt16
CHANNELS = 1


def open_stream():
    """Open input stream. Returns (pyaudio_instance, stream)."""
    p = pyaudio.PyAudio()
    stream = p.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=RATE,
        input=True,
        frames_per_buffer=CHUNK,
    )
    return p, stream


def close_stream(p, stream):
    """Stop and close stream, terminate PyAudio."""
    try:
        stream.stop_stream()
        stream.close()
    except Exception:
        pass
    try:
        p.terminate()
    except Exception:
        pass


def frames_to_wav_bytes(frames):
    """Raw mono 16 kHz 16-bit PCM bytes from frame list."""
    return b"".join(frames)
