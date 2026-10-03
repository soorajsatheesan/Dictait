#!/bin/bash
set -euo pipefail
DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DESKTOP/build/bin"
swiftc -O -target arm64-apple-macos14 -framework AppKit \
    -o "$DESKTOP/build/bin/dictait-helper" "$DESKTOP/native/helper.swift"
echo "Built $DESKTOP/build/bin/dictait-helper"
