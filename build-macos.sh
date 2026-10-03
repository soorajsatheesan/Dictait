#!/bin/bash
# Build the Electron desktop app into dist/Dictait.app and sign it locally.
set -euo pipefail
DICTAIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    echo "The macOS app requires an Apple Silicon Mac." >&2
    exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
    echo "Install Apple Command Line Tools first: xcode-select --install" >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    echo "Install Node.js 20 or later (https://nodejs.org or: brew install node), then rerun." >&2
    exit 1
fi
cd "$DICTAIT_ROOT/desktop"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run helper
mkdir -p build/python  # Filled only for downloadable builds (scripts/bundle-python.sh).
npx electron-vite build
npx electron-builder --mac dir --arm64 --publish never
DICTAIT_APP="$DICTAIT_ROOT/dist/Dictait.app"
rm -rf "$DICTAIT_APP"
ditto "$DICTAIT_ROOT/dist/electron/mac-arm64/Dictait.app" "$DICTAIT_APP"
# Ad-hoc sign everything, then give the app a stable designated requirement so
# macOS keeps Microphone and Accessibility permissions across rebuilds.
codesign --force --deep --sign - "$DICTAIT_APP"
codesign --force --sign - --identifier org.dictait.mac \
    --requirements '=designated => identifier "org.dictait.mac"' \
    --entitlements "$DICTAIT_ROOT/desktop/build/entitlements.mac.plist" "$DICTAIT_APP"
codesign --verify --deep --strict "$DICTAIT_APP"
echo "Built $DICTAIT_APP"
