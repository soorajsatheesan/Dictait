#!/bin/bash
# Copy voice-shortcuts.desktop to ~/.config/autostart/ so Super+I is registered at login.
DIR="$(cd "$(dirname "$0")" && pwd)"
AUTOSTART="$HOME/.config/autostart"
mkdir -p "$AUTOSTART"

# Write desktop file with correct Exec path for this machine
cat > "$AUTOSTART/voice-shortcuts.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Voice Shortcuts
Comment=Register Super+I for voice dictation (Whisper → clipboard)
Exec=$DIR/register-shortcut.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF

chmod +x "$DIR/register-shortcut.sh" 2>/dev/null || true
echo "Autostart enabled: $AUTOSTART/voice-shortcuts.desktop"
echo "Super+I will be registered on each login. Log out and back in (or reboot) to test."
