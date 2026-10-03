#!/bin/bash
# Build everything the website offers for download into marketing/downloads/:
#   Dictait-<version>-mac-arm64.dmg   self-contained app (bundled Python and speech engine)
#   Dictait-<version>-linux.tar.gz    the lightweight Linux version
#   SHA256SUMS.txt and latest.json    checksums and the manifest the website reads
#
# Usage: ./release.sh                       build locally
#        ./release.sh --publish owner/repo  also upload a GitHub Release (needs `gh auth login`)
#
# Signing: by default the app is signed locally (ad hoc), so macOS asks people to confirm the
# first launch. With an Apple Developer ID, set DICTAIT_SIGN_IDENTITY="Developer ID Application: …"
# and DICTAIT_NOTARY_PROFILE=<notarytool keychain profile> to sign, notarize and staple instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PUBLISH=""
if [[ "${1:-}" == "--publish" ]]; then PUBLISH="${2:?Usage: ./release.sh --publish owner/repo}"; fi
VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
OUT="$ROOT/marketing/downloads"
MAC="Dictait-$VERSION-mac-arm64.dmg"
LINUX="Dictait-$VERSION-linux.tar.gz"
mkdir -p "$OUT"

echo "› Bundling the speech engine"
if [[ ! -x "$ROOT/desktop/build/python/bin/python3" ]]; then bash "$ROOT/desktop/scripts/bundle-python.sh"; fi

echo "› Building the app"
"$ROOT/build-macos.sh"
APP="$ROOT/dist/Dictait.app"

if [[ -n "${DICTAIT_SIGN_IDENTITY:-}" ]]; then
    echo "› Signing with $DICTAIT_SIGN_IDENTITY"
    ENTITLEMENTS="$ROOT/desktop/build/entitlements.mac.plist"
    # Inside out: every library and executable, then helpers, then the app itself.
    find "$APP/Contents" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 |
        xargs -0 file | grep -E 'Mach-O' | cut -d: -f1 | while read -r binary; do
            codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$DICTAIT_SIGN_IDENTITY" "$binary"
        done
    find "$APP/Contents/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.app' \) -print0 |
        xargs -0 -I{} codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$DICTAIT_SIGN_IDENTITY" {}
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$DICTAIT_SIGN_IDENTITY" "$APP"
    codesign --verify --deep --strict "$APP"
fi

echo "› Packing $MAC"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Dictait.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT/$MAC"
hdiutil create -quiet -volname "Dictait" -srcfolder "$STAGE" -ov -format ULFO "$OUT/$MAC"
if [[ -n "${DICTAIT_SIGN_IDENTITY:-}" ]]; then
    codesign --force --timestamp --sign "$DICTAIT_SIGN_IDENTITY" "$OUT/$MAC"
    if [[ -n "${DICTAIT_NOTARY_PROFILE:-}" ]]; then
        echo "› Notarizing (this can take a few minutes)"
        xcrun notarytool submit "$OUT/$MAC" --keychain-profile "$DICTAIT_NOTARY_PROFILE" --wait
        xcrun stapler staple "$OUT/$MAC"
    fi
fi

echo "› Packing $LINUX"
cat > "$STAGE/INSTALL.txt" <<'TEXT'
Dictait for Linux (Debian, Ubuntu, Mint; Wayland or X11)

Super+I starts listening; Super+I again transcribes with Whisper on your computer and copies
the text, ready for Ctrl+V. Nothing is sent anywhere.

  sudo apt install python3-venv portaudio19-dev wl-clipboard   # or xclip on X11
  python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
  ./enable-autostart.sh

The first dictation downloads the Whisper model once (about 1.5 GB).
TEXT
mkdir -p "$STAGE/logs"
rm -f "$OUT/$LINUX"
tar -czf "$OUT/$LINUX" --exclude '__pycache__' -s ',^,dictait-linux/,' \
    -C "$STAGE" INSTALL.txt logs \
    -C "$ROOT" voice_shortcut.py voice_toggle.py voice_shortcuts run_super_i.sh register-shortcut.sh \
    enable-autostart.sh voice-shortcuts.desktop requirements.txt LICENSE

echo "› Writing checksums and manifest"
(cd "$OUT" && shasum -a 256 "$MAC" "$LINUX" > SHA256SUMS.txt)
size() { stat -f %z "$OUT/$1"; }
sum() { shasum -a 256 "$OUT/$1" | cut -d' ' -f1; }
url() { if [[ -n "$PUBLISH" ]]; then echo "https://github.com/$PUBLISH/releases/download/v$VERSION/$1"; else echo "downloads/$1"; fi; }
cat > "$OUT/latest.json" <<JSON
{
  "version": "$VERSION",
  "date": "$(date -u +%Y-%m-%d)",
  "signed": "$([[ -n "${DICTAIT_NOTARY_PROFILE:-}" ]] && echo notarized || ([[ -n "${DICTAIT_SIGN_IDENTITY:-}" ]] && echo developer-id || echo ad-hoc))",
  "mac": { "file": "$MAC", "size": $(size "$MAC"), "sha256": "$(sum "$MAC")", "url": "$(url "$MAC")" },
  "linux": { "file": "$LINUX", "size": $(size "$LINUX"), "sha256": "$(sum "$LINUX")", "url": "$(url "$LINUX")" }
}
JSON

if [[ -n "$PUBLISH" ]]; then
    echo "› Publishing v$VERSION to github.com/$PUBLISH"
    gh release create "v$VERSION" "$OUT/$MAC" "$OUT/$LINUX" "$OUT/SHA256SUMS.txt" \
        --repo "$PUBLISH" --title "Dictait $VERSION" --generate-notes \
        --notes "Dictait $VERSION for Apple Silicon Macs (macOS 14 or later) and Linux. Installed copies offer this update in Settings → Updates."
fi
ls -lh "$OUT"
