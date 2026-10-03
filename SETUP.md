# Dictait setup guide (for AI agents and humans)

This file lets a coding agent install and configure Dictait from a fresh download. If you are a person, you can give your agent this instruction:

> Read SETUP.md in this folder and set up Dictait for me.

Agents: follow the steps in order. Every step has a **check** you run first. Skip the step if the check already passes. Steps marked **🙋 Human** need the user to click or type something you cannot. Stop and ask them in plain language, then wait and re-run the check.

---

## Ground rules for agents

- Work from the repository root: the folder that contains `install-macos.sh` and this file.
- Never use `sudo`. Never edit macOS privacy databases (TCC), disable SIP, or bypass a system prompt. macOS permissions must come from the user.
- Never delete `~/Library/Application Support/Dictait/`. It holds the user's notes, vocabulary and settings.
- Dictait works offline after setup. The only network use is downloading dependencies and models: pip, npm, and Hugging Face for the models. Do not upload any files from the user's machine.
- Long-running commands are normal. The first install downloads about 3 GB of models and can take 5–20 minutes. Let it finish; don't restart it because it is quiet.
- Report progress to the user in short sentences, especially before steps that need them.

---

## 1. Identify the platform

```bash
uname -s; uname -m; sw_vers -productVersion 2>/dev/null
```

| Result | Path to follow |
|---|---|
| `Darwin`, `arm64`, macOS **14 or later** | Use **section 1b (install a release)** unless the user wants to build from source; then **section 2**. |
| `Darwin`, `x86_64` (Intel Mac) | Stop. Tell the user the desktop app needs Apple Silicon (M1 or later). |
| `Darwin`, macOS 13 or earlier | Stop. Tell the user to update macOS to 14 (Sonoma) or later. |
| `Linux` | Follow **section 8 (Linux)**. |

Check resources and warn the user (but continue) if they are low:

```bash
df -h "$HOME" | tail -1          # want at least 8 GB free
sysctl -n hw.memsize             # 17179869184 = 16 GB; 8 GB Macs work but are slower
```

---

## 1b. Install a release (fastest; no build tools needed)

- **Check:** `test -d /Applications/Dictait.app || test -d "$HOME/Applications/Dictait.app" && echo installed`
- **Install:**

  ```bash
  curl -fsSL https://raw.githubusercontent.com/soorajsatheesan/Dictait/main/install.sh | sh
  ```

  It downloads the latest release from GitHub, verifies its SHA-256 against the release's `SHA256SUMS.txt`, installs `Dictait.app` in `/Applications` (or `~/Applications`), and opens it. Nothing it downloads is quarantined, so there is no Gatekeeper prompt.

- **🙋 Human: the setup stage.** On first launch Dictait shows a four-step checklist: Microphone, Paste where you type (Accessibility), Voice models (a one-time ~3 GB download with progress), and Try it. Tell the user to follow it; each line ticks itself off. Then skip to **section 4** to verify, and **section 6** to configure.

If the user downloaded the disk image in a browser instead: they drag Dictait into Applications, open it, click **Done** on the "can't verify the developer" message, then click **Open Anyway** in System Settings → Privacy & Security. That is needed once; Dictait clears the quarantine flag from the rest of its bundle itself.

---

## 2. Prerequisites (macOS)

### 2a. Apple Command Line Tools

- **Check:** `xcode-select -p` prints a path and exits 0.
- **Fix:** run `xcode-select --install`. **🙋 Human:** macOS opens a dialog. Ask the user to click **Install** and wait for it to finish (a few minutes). Then re-run the check.

### 2b. Python 3.11, 3.12 or 3.13 (native Apple Silicon)

- **Check:** at least one of these prints `ok`:

  ```bash
  for p in python3.13 python3.12 python3.11 python3; do command -v $p >/dev/null && $p -c 'import sys,platform; assert (3,11) <= sys.version_info[:2] < (3,14) and platform.machine()=="arm64"; print("ok", sys.version.split()[0])' 2>/dev/null && break; done
  ```

- **Fix:** if Homebrew exists (`command -v brew`), run `brew install python@3.12`. Otherwise **🙋 Human:** ask the user to install Python 3.12 from https://www.python.org/downloads/macos/ (the "macOS 64-bit universal2 installer"), then re-check.

### 2c. Node.js 20 or later (builds the app)

- **Check:** `node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' && echo ok`
- **Fix:** `brew install node` if Homebrew exists. Otherwise **🙋 Human:** ask the user to install the LTS version from https://nodejs.org. If the user already has nvm: `nvm install --lts && nvm use --lts`.

### 2d. Homebrew (optional)

Only needed if you want to use it for the fixes above. Installing Homebrew asks for the user's password, so it is **🙋 Human**. Don't try to install it silently.

---

## 3. Install

```bash
./install-macos.sh
```

What it does, so you can report progress:

1. Creates a private Python runtime in `~/Library/Application Support/Dictait/runtime/`.
2. Downloads and warms the speech model (Whisper Large v3 Turbo) and the cleanup model (Qwen 2B). This is the slow part.
3. Builds the desktop app with npm and signs it locally.
4. Replaces `~/Applications/Dictait.app`, quitting any running copy first, and opens it.

**Success:** the output ends with `Installed /Users/<name>/Applications/Dictait.app`.

Useful flags:

- `--no-open`: install without launching.
- `--skip-models`: defer model downloads to the first launch.

The installer is safe to re-run. Updating later is the same command.

---

## 4. Verify the app is running

```bash
pgrep -x Dictait && cat "$HOME/Library/Application Support/Dictait/status.json"
```

- Poll every 10 seconds for up to 3 minutes until `"phase": "ready"`. `"preparing"` means the models are still loading.
- If `"phase": "failed"`, read the last lines of `~/Library/Application Support/Dictait/worker.log` and see **section 7**.
- `"shortcut_registered": false` means another app or macOS uses Control–Space. See **section 7**.

---

## 5. 🙋 Hand over to the user: permissions

These cannot be granted by an agent. Tell the user exactly this:

1. **Microphone:** "Click into any text box, press **Control–Space**, and choose **Allow** when macOS asks about the microphone."
2. **Automatic paste:** "Open **System Settings → Privacy & Security → Accessibility** and switch **Dictait** on. Without it, Dictait still works but leaves your words on the clipboard for ⌘V."
   - You may open the pane for them: `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`
3. **Login item** (optional): Dictait turns on Launch at Login itself. If macOS asks, approve it in **System Settings → General → Login Items**.

Then re-check `status.json`: `microphone_allowed` and `accessibility_allowed` should become `true`.

---

## 6. Configure (optional; ask the user first)

### Vocabulary

Ask the user for names, products and jargon they say often, and how Dictait mishears them. Add each one:

```bash
./dictait-memory.sh add "Qwen" --heard-as "queen"
./dictait-memory.sh add "Priya"
./dictait-memory.sh list
```

### Preferences

Preferences live in `~/Library/Application Support/Dictait/settings.json`. The app rewrites this file, so quit it first (`pkill -TERM -x Dictait`), edit the file, then `open ~/Applications/Dictait.app`.

| Key | Values | Meaning |
|---|---|---|
| `backend` | `"whisper"` (default), `"parakeet"` | Speech model. Parakeet: English/European only, no Hindi. |
| `language` | `"auto"`, `"en"`, `"hi"` | `"en"` skips language detection and is slightly faster. |
| `cleanup` | `true` / `false` | Grammar and filler cleanup with the local Qwen model. |
| `smartFormatting` | `true` / `false` | Follow spoken instructions like "make this into bullet points". |
| `writingStyle` | text, up to 300 characters | For example: `"Keep my casual tone; short sentences."` |
| `autoPaste` | `true` / `false` | Paste into the focused text box. Off means copy only. |
| `memoryMode` | `"notes"`, `"terms"`, `"off"` | Save dictations as searchable notes, only learn terms, or neither. |
| `learnCorrections` | `true` / `false` | Use saved correction examples during cleanup. |
| `appearance` | `"system"`, `"light"`, `"dark"` | Window theme. |
| `useContext` | `true` / `false` | Read the sentence before the cursor as a hint. Never saved. |
| `voiceEdits` | `true` / `false` | Rewrite selected text when the user speaks an instruction over it. |
| `appTones` | `true` / `false` | Adapt tone to the app (chat, email, code, docs). |
| `tones` | object with `messaging`, `email`, `code`, `docs` strings | How each kind of app should sound. |
| `microphone` | `"auto"`, `"system"`, or a device name | `"auto"` avoids Bluetooth headset mics. |
| `setupDone` | `true` / `false` | `false` shows the first-run setup checklist on the next launch. |
| `autoUpdate` | `true` / `false` | Check GitHub Releases for updates every few hours. Nothing installs without the user choosing **Update now**. |

Everything here is also in the app under **Settings**, which is easier for the user.

### Smoke test

**🙋 Human:** ask the user to open a text editor, press **Control–Space**, say a sentence, and press **Control–Space** again (or hold Control–Space while speaking and let go). The black island at the top of the screen should show their voice, then **Pasted**. If no text box has focus, Dictait shows **Copied** and leaves the text on the clipboard.

---

## 7. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| `install-macos.sh` says Python is missing | Section 2b check | Install Python 3.12, re-run. |
| npm or build errors | `node -v` (needs 20+) | Update Node, then `rm -rf desktop/node_modules` and re-run. |
| Model download fails | Network access to `huggingface.co` | Retry `./install-macos.sh`; downloads resume. |
| `phase` stays `failed` | `tail -40 ~/Library/Application\ Support/Dictait/worker.log` | Use **Retry models** in the menu bar, or re-run the installer. A missing package means `runtime/` is damaged: re-run the installer. |
| Control–Space does nothing; `shortcut_registered: false` | macOS input-source shortcut | **🙋 Human:** System Settings → Keyboard → Keyboard Shortcuts → Input Sources: turn off or change Control–Space. Then choose **Retry Control–Space shortcut** in Dictait's menu. |
| Text is copied but never pasted | `accessibility_allowed` in status.json | Section 5, step 2. After a rebuild, switch Dictait off and on again in that list. |
| Holding Control–Space doesn't finish on release | `open -n -a ~/Applications/Dictait.app --args --check-hotkeys /tmp/dictait-hotkeys.json; sleep 4; cat /tmp/dictait-hotkeys.json` | `"events":["down","up"]` means the shortcut works. Otherwise tapping still works; report the file's contents. |
| "No speech detected" | Input device | **🙋 Human:** check System Settings → Sound → Input. Bluetooth headsets (for example AirPods) lower quality while their mic is in use, so prefer the built-in mic. |
| Very slow first dictation | `phase` | First launch warms the models; later dictations take well under a second for short clips. |

Logs never contain dictated text. `status.json` contains no transcripts.

---

## 7b. Updates

Installed copies check `github.com/soorajsatheesan/Dictait/releases` a little after launch and every six hours (unless `autoUpdate` is off). **Settings → Updates → Update now** downloads the new disk image, verifies its checksum, swaps the app in place and reopens it. Notes, vocabulary, settings, models and permissions are kept. A source install updates by re-running `./install-macos.sh` (or switching to the release with section 1b).

---

## 8. Linux

The Linux version is a simpler, separate tool: Super+I to toggle, result copied to the clipboard. On Debian or Ubuntu:

```bash
sudo apt install python3-venv portaudio19-dev wl-clipboard   # 🙋 Human: needs their password; or xclip on X11
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./enable-autostart.sh
```

See the Linux section of `README.md` for details.

---

## 9. Uninstall

```bash
./uninstall-macos.sh
```

This removes the app but keeps the user's notes, the runtime and the models. Delete `~/Library/Application Support/Dictait/` **only if the user explicitly asks** to erase their notes and vocabulary.
