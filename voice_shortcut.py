#!/usr/bin/env python3
"""
Record from mic until SIGTERM, then transcribe with Whisper (medium) and copy to clipboard.
Started by voice_toggle.py: Super+I = start, Super+I again = stop → transcribe → clipboard.
"""
import os
import signal
import sys
import threading
from pathlib import Path

_root = Path(__file__).resolve().parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from voice_shortcuts.config import PID_FILE
from voice_shortcuts.audio import CHUNK, open_stream, close_stream, frames_to_wav_bytes
from voice_shortcuts.stt import transcribe
from voice_shortcuts.paste import copy_to_clipboard
from voice_shortcuts.ui import has_ui, show_listening, switch_to_processing, animate_spinner, destroy

running = [True]


def on_signal(sig, frame):
    running[0] = False
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    PID_FILE.write_text(str(os.getpid()))

    p, stream = open_stream()
    frames = []
    root = None

    if has_ui():
        root, icon_label, text_label = show_listening()
    else:
        root = icon_label = text_label = None

    def record():
        while running[0]:
            try:
                frames.append(stream.read(CHUNK, exception_on_overflow=False))
            except Exception:
                if not running[0]:
                    break

    if root is None:
        while running[0]:
            try:
                frames.append(stream.read(CHUNK, exception_on_overflow=False))
            except Exception:
                if not running[0]:
                    break
        close_stream(p, stream)
    else:
        th = threading.Thread(target=record, daemon=True)
        th.start()

        result_holder = [None]

        def check():
            if th.is_alive():
                root.after(100, check)
                return
            close_stream(p, stream)
            raw = frames_to_wav_bytes(frames)
            if not raw:
                destroy(root)
                sys.exit(0)

            switch_to_processing(icon_label, text_label)

            def do_transcribe():
                result_holder[0] = transcribe(raw)

            rec_th = threading.Thread(target=do_transcribe, daemon=True)
            rec_th.start()
            animate_spinner(icon_label, rec_th.is_alive)

            def check_recognize():
                if rec_th.is_alive():
                    root.after(100, check_recognize)
                    return
                text = result_holder[0] or ""
                copy_to_clipboard(text)
                destroy(root)
                sys.exit(0)

            root.after(100, check_recognize)

        root.after(100, check)
        root.mainloop()
        return

    close_stream(p, stream)
    raw = frames_to_wav_bytes(frames)
    if not raw:
        sys.exit(0)
    text = transcribe(raw)
    copy_to_clipboard(text)


if __name__ == "__main__":
    main()
