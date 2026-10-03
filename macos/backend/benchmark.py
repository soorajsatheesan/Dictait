#!/usr/bin/env python3
"""Measure actual warm transcription/cleanup latency using a 16 kHz PCM WAV."""
import argparse
import json
import time
from worker import Engine, read_audio, trim_silence

parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("--backend", choices=("whisper", "parakeet"), default="whisper")
parser.add_argument("--no-cleanup", action="store_true")
parser.add_argument("--runs", type=int, default=3)
args = parser.parse_args()
engine = Engine(args.backend, not args.no_cleanup, memory=False)
engine.prepare(print)
audio = trim_silence(read_audio(args.audio))
if not len(audio):
    raise SystemExit("No speech found in the WAV file.")
for run in range(args.runs):
    start = time.perf_counter()
    raw = engine.transcribe(audio, "en")
    stt = time.perf_counter() - start
    text, warning = engine.clean(raw) if not args.no_cleanup else (raw, None)
    print(json.dumps({"run": run + 1, "audio_seconds": round(len(audio) / 16000, 2),
                      "stt_seconds": round(stt, 3), "total_seconds": round(time.perf_counter() - start, 3),
                      "raw": raw, "text": text, "warning": warning}, ensure_ascii=False), flush=True)
