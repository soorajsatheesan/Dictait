#!/bin/bash
# Bundle a relocatable Python with Dictait's speech engine into build/python, so a downloaded
# app runs without install-macos.sh. Source: python-build-standalone (Astral), checksum-verified.
set -euo pipefail
DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DESKTOP/.." && pwd)"
TAG="20261001"
NAME="cpython-3.12.15+${TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz"
BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}"
CACHE="$DESKTOP/build/cache"
OUT="$DESKTOP/build/python"
mkdir -p "$CACHE"
if [[ ! -f "$CACHE/$NAME" ]]; then
    curl -fsSL --retry 3 -o "$CACHE/$NAME.part" "$BASE/${NAME//+/%2B}"
    mv "$CACHE/$NAME.part" "$CACHE/$NAME"
fi
curl -fsSL --retry 3 -o "$CACHE/SHA256SUMS-$TAG" "$BASE/SHA256SUMS"
expected="$(grep " $NAME\$" "$CACHE/SHA256SUMS-$TAG" | cut -d' ' -f1)"
actual="$(shasum -a 256 "$CACHE/$NAME" | cut -d' ' -f1)"
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for $NAME; refusing to bundle it." >&2
    exit 1
fi
rm -rf "$OUT"
mkdir -p "$OUT"
tar -xzf "$CACHE/$NAME" -C "$OUT" --strip-components 1
PIP_DISABLE_PIP_VERSION_CHECK=1 "$OUT/bin/python3" -m pip install --no-warn-script-location -q -r "$ROOT/macos/requirements.txt"
# torch only converts model checkpoints; Dictait never imports it at runtime.
"$OUT/bin/python3" -m pip uninstall -y -q torch sympy networkx mpmath
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$OUT/lib/python3.12/site-packages" -type d -name tests -prune -exec rm -rf {} +
"$OUT/bin/python3" -B -c "import mlx_whisper, mlx_lm, parakeet_mlx, numpy, scipy; print('Speech engine imports cleanly.')"
du -sh "$OUT"
