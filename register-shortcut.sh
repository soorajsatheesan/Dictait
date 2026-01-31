#!/bin/bash
# Register Super+I keybinding for Voice Shortcuts via gsettings (GNOME).
# Run at login via autostart, or once manually.
DIR="$(cd "$(dirname "$0")" && pwd)"
CMD="$DIR/run_super_i.sh"
PATH_ID="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom99/"

# Check for gsettings (GNOME)
if ! command -v gsettings &>/dev/null; then
  exit 0
fi

CURRENT="$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings 2>/dev/null)" || CURRENT="[]"
# Ensure our path is in the list (idempotent)
if [[ "$CURRENT" != *"custom99"* ]]; then
  LIST="${CURRENT%\]}"
  if [[ "$LIST" == "[" ]]; then
    LIST="['$PATH_ID']"
  else
    LIST="$LIST, '$PATH_ID']"
  fi
  gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "$LIST" 2>/dev/null || true
fi

gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$PATH_ID" name "Voice Shortcuts" 2>/dev/null || true
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$PATH_ID" command "$CMD" 2>/dev/null || true
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$PATH_ID" binding "<Super>i" 2>/dev/null || true
exit 0
