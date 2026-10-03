#!/bin/sh
# Install Dictait for Mac from the latest GitHub Release.
#
#   curl -fsSL https://raw.githubusercontent.com/soorajsatheesan/Dictait/main/install.sh | sh
#
# (install-macos.sh builds from source instead.)
#
# Downloads the disk image, checks its SHA-256 against the release's SHA256SUMS.txt, and copies
# Dictait.app into /Applications (or ~/Applications when /Applications is not writable).
# Files fetched with curl carry no quarantine flag, so macOS opens the app without asking.
set -eu

REPO="${DICTAIT_REPO:-soorajsatheesan/Dictait}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'Dictait: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS. Linux builds are on the website."
[ "$(uname -m)" = arm64 ] || fail "Dictait needs a Mac with Apple Silicon (M1 or later)."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 14 ] || fail "Dictait needs macOS 14 or later."

say "Finding the latest Dictait release"
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") || fail "could not reach GitHub."
asset() { printf '%s' "$release" | grep -o "\"browser_download_url\": *\"[^\"]*$1\"" | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/'; }
dmg_url=$(asset '-mac-arm64\.dmg')
sums_url=$(asset 'SHA256SUMS\.txt')
[ -n "$dmg_url" ] || fail "the latest release has no Mac build."

work=$(mktemp -d)
cleanup() { hdiutil detach "$work/volume" -quiet 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM

say "Downloading $(basename "$dmg_url")"
curl -fL --progress-bar "$dmg_url" -o "$work/Dictait.dmg" || fail "the download failed."

if [ -n "$sums_url" ]; then
    expected=$(curl -fsSL "$sums_url" | grep -- '-mac-arm64\.dmg' | awk '{print $1}')
    actual=$(shasum -a 256 "$work/Dictait.dmg" | awk '{print $1}')
    [ "$expected" = "$actual" ] || fail "the download does not match its published checksum. Nothing was installed."
    say "Checksum verified"
fi

hdiutil attach "$work/Dictait.dmg" -nobrowse -readonly -mountpoint "$work/volume" -quiet || fail "could not open the disk image."
[ -d "$work/volume/Dictait.app" ] || fail "the disk image has no Dictait.app."

target=/Applications
[ -w "$target" ] || { target="$HOME/Applications"; mkdir -p "$target"; }
osascript -e 'tell application "Dictait" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$target/Dictait.app"
ditto "$work/volume/Dictait.app" "$target/Dictait.app"
xattr -dr com.apple.quarantine "$target/Dictait.app" 2>/dev/null || true

say "Dictait is installed in $target"
echo "Opening it now. On first launch it asks for the microphone and Accessibility, then downloads its voice models once (about 3 GB)."
open "$target/Dictait.app"
