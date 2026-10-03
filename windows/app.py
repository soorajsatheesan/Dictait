"""Windows dictation: Ctrl+Alt+Space toggles recording; Ctrl+V pastes the result."""
import ctypes
from ctypes import wintypes
import queue
import sys
import threading
from pathlib import Path
import tkinter as tk
from tkinter import ttk
import webbrowser

from windows.core import MAX_SECONDS, MODELS, RATE, SpeechEngine

BG, SURFACE, INK, MUTED, ORANGE = "#11100f", "#211c18", "#f6f0e9", "#bbae9f", "#f9853b"
HOTKEY_ID, WM_HOTKEY = 0xD1C7, 0x0312


class App:
    def __init__(self, root):
        self.root = root
        self.engine = SpeechEngine()
        self.events = queue.Queue()
        self.state = "setup"
        self.stream = None
        self.frames = []
        self.samples = 0
        self.capture_lock = threading.Lock()
        self.hotkey = False
        self.closing = False
        self.root.title("Dictait")
        self.root.geometry("580x560")
        self.root.minsize(520, 520)
        self.root.configure(bg=BG)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        try:
            self.root.iconbitmap(str(Path(__file__).with_name("icon.ico")))
        except tk.TclError:
            pass
        panel = tk.Frame(root, bg=BG, padx=32, pady=28)
        panel.pack(fill="both", expand=True)
        self.label(panel, "DICTAIT / WINDOWS", 11, ORANGE).pack(anchor="w")
        self.label(panel, "Talk. It types.", 34, INK, "bold").pack(anchor="w", pady=(18, 10))
        self.label(panel, "Private dictation. Your voice stays on this PC.", 12).pack(anchor="w")
        card = tk.Frame(panel, bg=SURFACE, padx=22, pady=20)
        card.pack(fill="x", pady=24)
        self.label(card, "1. Choose a voice model", 14, INK, "bold").pack(anchor="w")
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TCombobox", fieldbackground=SURFACE, background=SURFACE, foreground=INK)
        self.model = tk.StringVar(value=MODELS[self.engine.saved_model()])
        self.picker = ttk.Combobox(card, textvariable=self.model, values=list(MODELS.values()), state="readonly")
        self.picker.pack(fill="x", pady=(12, 8))
        self.setup_button = self.button(card, "Download model & finish setup", self.setup)
        self.setup_button.pack(fill="x", pady=8)
        self.progress = ttk.Progressbar(card, mode="indeterminate")
        self.label(card, "One download from Hugging Face. Then it works offline.", 10).pack(anchor="w")
        self.status = self.label(panel, "Choose a model to get started.", 12, INK)
        self.status.pack(fill="x", pady=(0, 12))
        self.record_button = self.button(panel, "Start dictation · Ctrl+Alt+Space", self.toggle)
        self.record_button.config(state="disabled")
        self.record_button.pack(fill="x")
        self.label(panel, "2. Speak, stop, then paste with Ctrl+V in any app.\nKeep this window open; the shortcut works in other apps.\nRecordings stop after 5 minutes and are deleted after transcription.", 10).pack(anchor="w", pady=14)
        updates = tk.Button(panel, text="Updates on GitHub ↗", command=lambda: webbrowser.open("https://github.com/soorajsatheesan/Dictait/releases/latest"), bg=BG, fg=MUTED, relief="flat", cursor="hand2")
        updates.pack(anchor="w")
        self.root.after(80, self.poll)
        if self.engine.is_downloaded(self.engine.saved_model()):
            self.setup(allow_download=False)

    def label(self, parent, text, size, color=MUTED, weight="normal"):
        return tk.Label(parent, text=text, bg=parent["bg"], fg=color, font=("Segoe UI", size, weight), justify="left", anchor="w", wraplength=470)

    def button(self, parent, text, command):
        return tk.Button(parent, text=text, command=command, bg=ORANGE, fg="#201209", activebackground="#ffa364", activeforeground="#201209", font=("Segoe UI", 12, "bold"), relief="flat", borderwidth=0, pady=10, cursor="hand2")

    def setup(self, allow_download=True):
        if self.state in ("loading", "recording", "processing"):
            return
        name = next(name for name, title in MODELS.items() if title == self.model.get())
        self.state = "loading"
        self.setup_button.config(state="disabled")
        self.picker.config(state="disabled")
        self.record_button.config(state="disabled")
        self.status.config(text="Downloading and loading your model…" if allow_download else "Loading your saved model…")
        self.progress.pack(fill="x", pady=8)
        self.progress.start()

        def work():
            try:
                self.engine.prepare(name, allow_download)
                self.events.put(("ready", None))
            except Exception:
                self.events.put(("setup_error", None))
        threading.Thread(target=work, daemon=True).start()

    def register_hotkey(self):
        if self.hotkey:
            return
        # Register to this UI thread, then drain only WM_HOTKEY messages in poll().
        self.hotkey = bool(ctypes.windll.user32.RegisterHotKey(None, HOTKEY_ID, 0x4000 | 0x0001 | 0x0002, 0x20))

    def toggle(self):
        if self.state == "recording":
            self.stop()
        elif self.state == "ready":
            self.start()

    def start(self):
        try:
            import sounddevice as sd
            with self.capture_lock:
                self.frames, self.samples = [], 0
            self.stream = sd.RawInputStream(samplerate=RATE, channels=1, dtype="int16", callback=self.audio)
            self.state = "recording"
            self.stream.start()
            self.record_button.config(text="Stop & transcribe · Ctrl+Alt+Space")
            self.setup_button.config(state="disabled")
            self.picker.config(state="disabled")
            self.status.config(text="Listening… Press the shortcut again to finish.")
        except Exception:
            self.release_stream()
            self.state = "ready"
            self.status.config(text="Microphone unavailable. Check Windows microphone permissions and your default input device.")

    def audio(self, data, frames, timing, status):
        if self.state != "recording":
            return
        with self.capture_lock:
            room = RATE * MAX_SECONDS - self.samples
            if room <= 0:
                return
            count = min(room, frames)
            self.frames.append(bytes(data)[:count * 2])
            self.samples += count
            if self.samples >= RATE * MAX_SECONDS:
                self.events.put(("limit", None))

    def release_stream(self):
        if self.stream:
            try:
                self.stream.stop()
            finally:
                self.stream.close()
                self.stream = None

    def stop(self):
        self.state = "processing"
        self.release_stream()
        with self.capture_lock:
            pcm = b"".join(self.frames)
            self.frames = []
        self.record_button.config(state="disabled", text="Transcribing on your PC…")
        self.status.config(text="Transcribing locally…")

        def work():
            try:
                self.events.put(("text", self.engine.transcribe(pcm)))
            except Exception:
                self.events.put(("transcription_error", None))
        threading.Thread(target=work, daemon=True).start()

    def poll(self):
        if self.hotkey:
            message = wintypes.MSG()
            while ctypes.windll.user32.PeekMessageW(ctypes.byref(message), None, WM_HOTKEY, WM_HOTKEY, 1):
                if message.wParam == HOTKEY_ID:
                    self.toggle()
        try:
            while True:
                event, value = self.events.get_nowait()
                if event == "limit" and self.state == "recording":
                    self.stop()
                elif event == "ready":
                    self.state = "ready"
                    self.progress.stop()
                    self.progress.pack_forget()
                    self.setup_button.config(state="normal", text="Load / download selected model")
                    self.picker.config(state="readonly")
                    self.register_hotkey()
                    self.record_button.config(state="normal", text="Start dictation · Ctrl+Alt+Space")
                    self.status.config(text="Ready. Press Ctrl+Alt+Space anywhere to talk." if self.hotkey else "Shortcut already in use. Use Start dictation here.")
                elif event == "setup_error":
                    self.state = "setup"
                    self.progress.stop()
                    self.progress.pack_forget()
                    self.setup_button.config(state="normal", text="Retry model setup")
                    self.picker.config(state="readonly")
                    self.status.config(text="Couldn’t load the model. Check your connection and free disk space, then retry.")
                elif event in ("text", "transcription_error"):
                    if self.closing:
                        self.close()
                        return
                    self.state = "ready"
                    self.setup_button.config(state="normal")
                    self.picker.config(state="readonly")
                    self.record_button.config(state="normal", text="Start dictation · Ctrl+Alt+Space")
                    if event == "text" and value:
                        try:
                            self.root.clipboard_clear()
                            self.root.clipboard_append(value)
                            self.status.config(text="Copied. Press Ctrl+V where you want your words.")
                        except tk.TclError:
                            self.status.config(text="Clipboard busy. Try dictating again once the other app finishes.")
                    else:
                        self.status.config(text="Couldn’t transcribe. Try again." if event == "transcription_error" else "No speech detected. Try again.")
        except queue.Empty:
            pass
        self.root.after(80, self.poll)

    def close(self):
        if self.state == "processing" and not self.closing:
            self.closing = True
            self.root.withdraw()
            return
        self.state = "closed"
        self.release_stream()
        self.frames = []
        if self.hotkey:
            ctypes.windll.user32.UnregisterHotKey(None, HOTKEY_ID)
        self.root.destroy()


def main():
    if sys.platform != "win32":
        raise SystemExit("This app runs on Windows. See README.md for macOS and Linux.")
    if "--self-test" in sys.argv:
        # CI checks frozen imports and native speech/audio libraries without recording or downloading models.
        import sounddevice
        import faster_whisper
        import numpy
        root = tk.Tk()
        root.withdraw()
        app = App(root)
        root.update()
        app.register_hotkey()
        app.close()
        return
    kernel = ctypes.windll.kernel32
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel.CreateMutexW(None, False, "Local\\DictaitWindows")
    if not mutex:
        raise SystemExit("Could not create the Dictait instance lock.")
    if kernel.GetLastError() == 183:
        kernel.CloseHandle(mutex)
        return
    try:
        root = tk.Tk()
        App(root)
        root.mainloop()
    finally:
        kernel.CloseHandle(mutex)


if __name__ == "__main__":
    main()
