# Contributing to Dictait

Thanks for your interest in contributing to Dictait.

## How to contribute

- **Bug reports and feature ideas**  
  Open an [issue](../../issues) describing the problem or suggestion.

- **Code changes**  
  1. Fork the repo and create a branch from `main` (or `master`).
  2. Make your changes and test them (macOS: Control–Space; Linux: Super+I).
  3. Open a pull request with a short description of what changed and why.

## Development setup

### macOS

- Apple Silicon, macOS 14+, native Python 3.11–3.13, Node.js 20+, Apple Command Line Tools.
- Run `./install-macos.sh` for the full local setup; `./build-macos.sh` only builds.
- The desktop app lives in `desktop/` (Electron, TypeScript, React, Motion). `npm run dev` runs it with live reload against your local runtime; `npm run web` renders the interface in a browser with sample notes; `npm run typecheck` must pass.
- `native/helper.swift` is a persistent companion process (JSON lines over stdin/stdout) for shortcuts with press and release, the focused text field, ⌘V and microphones. `Dictait --check-hotkeys out.json`, launched with `open -n -a Dictait --args …` so the app's Accessibility permission applies, confirms presses and releases arrive.
- Text around the cursor and selections are personal data: use them only for the current dictation, never log or persist them, and never read password fields.
- The island (`src/main/hud.ts`, `src/renderer/src/hud/`) must never take keyboard focus or activate Dictait. Closing the main window keeps dictation available; login launch stays in the background.
- Design language: graphite neutrals with one warm accent, ember, reserved for voice, live state and your own content; the logo gradient (#FF9456 → #FF4A2E) and liquid glass for the island, the Dictate button and first-run setup. The mark lives in `desktop/resources/brand/`; keep its path identical everywhere. Motion uses critically damped springs; only the island bounces. Respect Reduce Motion. Review changes in light and dark with `Dictait --preview setup|notes|graph|vocabulary|settings out.png light|dark` and `Dictait --preview hud:recording out.png`; previews use synthetic notes and never record audio.
- Local inference lives in `macos/backend/worker.py`; the stdout protocol is newline-delimited JSON. Keep logs on stderr and never log dictated text. Contextual memory and vault exports live in `macos/backend/memory.py`.
- Run `"$HOME/Library/Application Support/Dictait/runtime/bin/python" -m unittest discover -s macos/tests -v`.
- Check real microphone input, permission denial, Control–Space conflicts, island visibility without focus theft, auto-paste, silence, repeated recordings, worker recovery, spoken writing instructions, contextual terms, notes-mode persistence and launch at login before releasing.
- Measure speed using `macos/backend/benchmark.py`; report audio duration, model, warm/cold state and hardware rather than promising fixed latency.

### Releases

Bump `version` in `desktop/package.json` and push to `main`: the Release workflow builds the disk image and Linux bundle and publishes them on GitHub, and installed copies offer the update. Releases are ad hoc signed unless `DICTAIT_SIGN_IDENTITY` and `DICTAIT_NOTARY_PROFILE` are set (see `release.sh`).

### Linux

- Python 3.10+
- Create a venv, install deps: `pip install -r requirements.txt`
- Follow the [README](README.md) setup for shortcut, clipboard, and autostart.

## Code style

- Use the existing style in the project (formatting, naming).
- Keep changes focused; separate unrelated fixes into different PRs.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
