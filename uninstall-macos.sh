#!/bin/bash
set -euo pipefail
echo "Turn off Launch at login in Dictait (or remove it in System Settings → General → Login Items)."
if pgrep -x Dictait >/dev/null 2>&1; then pkill -TERM -x Dictait; fi
DICTAIT_APP="$HOME/Applications/Dictait.app"
if [[ -d "$DICTAIT_APP" ]]; then rm -rf "$DICTAIT_APP"; fi
echo "Removed the app. The runtime and model cache are retained for other installations."
echo "Optional removal: ~/Library/Application Support/Dictait"
echo "Optional preferences reset: defaults delete org.dictait.mac"
