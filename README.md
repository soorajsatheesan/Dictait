# Dictait

**Dictait** is a lightweight voice-to-text tool for Linux that brings Windows-style “press a key and dictate” to your desktop. On Windows, **Win+H** turns on built-in speech recognition and types for you; Linux has no native equivalent. Dictait fills that gap: press **Super+I** to start listening, press it again to stop—then your words are transcribed and copied to the clipboard so you can paste them anywhere (email, chat, editor) with **Ctrl+V**.

It targets **Linux on Debian-based distributions** (Ubuntu, Debian, Linux Mint, etc.) and works on both **Wayland** and **X11**. Everything runs locally using the **Whisper** model—no cloud, no account, no telemetry.

---

## Features

- **Toggle with one shortcut**  
  **Super+I** once starts the microphone; **Super+I** again stops recording, runs transcription, and copies the result to the clipboard. No need to hold the key.

- **Clear visual feedback**  
  A small overlay shows “Listening…” while recording and “Processing…” with a spinner while Whisper transcribes, so you always know the current state.

- **Paste where you need it**  
  Dictait only copies text to the clipboard. You choose where to paste: email, browser, terminal, IDE—anywhere that accepts **Ctrl+V**.

- **Runs fully offline**  
  Speech recognition uses **Whisper** (via `faster-whisper`) on your machine. No data is sent to the internet.

- **Ready after every login**  
  With the included autostart setup, the **Super+I** shortcut is registered at login so dictation is available as soon as you sign in, without starting anything manually.

- **Lightweight and simple**  
  No long-running daemon. The shortcut runs a small script; recording and transcription run only when you use Super+I.

---

## How It Works

### User flow

1. You press **Super+I** → Dictait starts recording from your microphone and shows “Listening…”.
2. You speak (email, note, command, etc.).
3. You press **Super+I** again → Recording stops, the overlay switches to “Processing…”, and Whisper transcribes the audio.
4. When transcription finishes, the text is copied to the clipboard and the overlay closes.
5. You go to your app (e.g. email, chat) and press **Ctrl+V** to paste.

### High-level architecture

- **Shortcut (Super+I)**  
  Registered with the desktop (e.g. GNOME) so that when you press Super+I, it runs a script (`run_super_i.sh` → `voice_toggle.py`).

- **Toggle logic**  
  `voice_toggle.py` checks whether a recorder is already running (via a PID file).  
  - If **not** running → it starts `voice_shortcut.py` (record until stopped).  
  - If **running** → it sends **SIGTERM** to that process so it stops recording and continues with transcription and clipboard.

- **Recording and transcription**  
  `voice_shortcut.py` captures audio (PyAudio), waits for SIGTERM, then converts the recorded frames to PCM, runs Whisper (via `voice_shortcuts.stt`), and copies the result to the clipboard (Wayland: `wl-copy`, X11: `xclip`/`xsel`).

- **Autostart**  
  A desktop file in `~/.config/autostart/` runs `register-shortcut.sh` at login, which re-registers the Super+I keybinding with the desktop so it works on every session.

### Low-level / core flow

1. **Audio**  
   PyAudio opens the default microphone at 16 kHz, mono, 16-bit PCM. Frames are appended to a list until the process receives SIGTERM.

2. **PCM → WAV**  
   Recorded frames are concatenated and passed to the STT layer as raw PCM. The STT module writes a temporary WAV file for Whisper.

3. **Transcription**  
   **faster-whisper** loads the Whisper model once (lazy). The default is the **medium** model (configurable). Transcription runs with VAD and English language hint; output is joined into a single string.

4. **Clipboard**  
   The resulting text is written to the system clipboard (Wayland: `wl-copy`, X11: `xclip` or `xsel`). No automatic typing or pasting—you paste with Ctrl+V.

5. **UI**  
   If tkinter is available, a small frameless overlay is shown (“Listening…” then “Processing…” with spinner). If not, everything runs headless and only clipboard is updated.

### Model and credits

- **Speech recognition**  
  [Whisper](https://github.com/openai/whisper) (OpenAI). Dictait uses the **medium** model by default for a good balance of speed and accuracy.

- **Inference**  
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) by Sylvain Durand—a reimplementation of Whisper with CTranslate2, so it runs efficiently on CPU (e.g. int8).

- **Audio**  
  [PyAudio](https://people.csail.mit.edu/hubert/pyaudio/) for microphone capture.

### Project structure

```
voice-shortcuts/           # Project root (Dictait)
├── voice_shortcut.py      # Main recorder: record → SIGTERM → transcribe → clipboard
├── voice_toggle.py        # Toggle: start recorder or send SIGTERM to stop
├── run_super_i.sh         # Script run by Super+I (calls voice_toggle.py)
├── register-shortcut.sh   # Registers Super+I with GNOME (gsettings)
├── enable-autostart.sh    # Installs autostart entry so shortcut works every login
├── voice-shortcuts.desktop  # Template for autostart entry
├── requirements.txt      # Python deps: pyaudio, faster-whisper
├── logs/                  # Optional logs
└── voice_shortcuts/       # Python package
    ├── config.py          # Paths, WHISPER_MODEL, etc.
    ├── audio.py          # PyAudio open/close, frame capture, PCM
    ├── stt.py             # Whisper (faster-whisper) transcription
    ├── paste.py           # Clipboard (wl-copy / xclip / xsel)
    └── ui.py              # Listening/Processing overlay (tkinter)
```

---

## Setup

These steps assume a **Debian-based** system (Ubuntu, Debian, Linux Mint, etc.) and that you want Dictait to work **on every login** via Super+I.

### 1. Clone or download the repo

```bash
git clone <repository-url> ~/voice-shortcuts
cd ~/voice-shortcuts
```

If you don’t use git, download and extract the project into a folder (e.g. `~/voice-shortcuts`) and `cd` into it.

### 2. Python environment

- **Python 3.10+** is required.

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

The first run of Dictait will download the Whisper model (default: **medium**, ~1.5 GB). This happens once.

### 3. Clipboard and audio

- **Wayland** (typical on Ubuntu 22.04+):  
  `sudo apt install wl-clipboard`

- **X11**:  
  `sudo apt install xclip`  
  (or `xsel`)

- **Microphone**: ensure your mic is working and allowed in system settings.

### 4. Bind Super+I and enable autostart

From the project directory:

```bash
./enable-autostart.sh
```

This will:

- Install an autostart entry that runs at login and registers **Super+I** with your desktop (GNOME).
- Use the **custom99** keybinding slot so it doesn’t overwrite existing shortcuts.

After this, **Super+I** will be registered on each login. You can **log out and back in** (or reboot) to verify, or run once manually:

```bash
./register-shortcut.sh
```

### 5. Optional: manual shortcut (if not using autostart)

If you prefer not to use autostart, add the shortcut yourself:

- **GNOME:** Settings → Keyboard → Keyboard Shortcuts → Custom Shortcuts → Add.
- **Name:** e.g. `Dictait`
- **Command:** `/home/YOUR_USERNAME/voice-shortcuts/run_super_i.sh`  
  (use your real path; replace `YOUR_USERNAME` with your username.)
- **Shortcut:** Super+I

### 6. Optional: change Whisper model

Edit or set before running:

- **Environment:**  
  `export VOICE_WHISPER_MODEL=tiny`  
  (or `base`, `small`, `medium`, `large-v3`)

- **Default** in code is **medium** (see `voice_shortcuts/config.py`).

---

## License

This project is provided as-is. Use and modify it as you like. Whisper and faster-whisper have their own licenses (see their repositories). Dictait does not include a separate license file; treat the code as open for personal and educational use unless you add a license yourself.

---

*Last updated: January 2026*
