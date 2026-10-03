# Dictait for Windows

A lightweight local dictation app for Windows 10 or later (64-bit x86). Whisper transcribes on your CPU and copies your words for Ctrl+V. Python is included in the ZIP; no account or subscription.

1. Download `Dictait-x.y.z-windows-x64.zip` from https://github.com/soorajsatheesan/Dictait/releases/latest.
2. Extract the **entire** ZIP into a folder. Keep `Dictait.exe` and `_internal` together.
3. Open `Dictait.exe`. Choose a voice model and click **Download model & finish setup**. Base is fastest (~150 MB), Small is balanced (~500 MB), Medium is more accurate (~1.5 GB). The download comes from Hugging Face; the setup indicator stays active while downloading and loading.
4. Keep Dictait open. Press **Ctrl+Alt+Space** in any app to start recording and again to stop. Paste with **Ctrl+V**. The button in Dictait also works when another app owns the shortcut.

Allow desktop apps to use the microphone under Windows Settings → Privacy & security → Microphone. Recording stops after five minutes. Audio is deleted after transcription, including when transcription fails. Normal exit discards an unfinished recording.

After the first model download, dictation works offline. Models and the chosen model setting live in `%LOCALAPPDATA%\Dictait`. Recordings and transcripts are not stored as notes. Only dictation text is copied to the Windows clipboard, so your Windows clipboard-history/sync settings apply.

This Windows app currently provides speech-to-text and clipboard copying. Qwen cleanup, voice editing, the notes graph and automatic updates are Mac features. Use **Updates on GitHub** for Windows updates: extract the newer ZIP in a new folder, close the old app and run the new one. Cached models stay in place.

## Run from source

Install Python 3.12 (64-bit), open PowerShell in the repository root, then:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -r windows/requirements.txt
.\.venv\Scripts\python -m windows.app
```

## Package on Windows

`windows/build.ps1` packages a portable ZIP using PyInstaller and checks that the frozen app imports its audio and speech libraries. The Windows and Release workflows run it on GitHub; neither the Python runtime nor models need to be uploaded from a maintainer's computer. Models are downloaded by the user in setup.
