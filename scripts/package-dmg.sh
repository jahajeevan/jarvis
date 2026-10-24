#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/build-macos-app.sh"

STAGE="$ROOT/build/dmg-stage"
DMG="$ROOT/build/JARVIS-0.1.0-arm64.dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$ROOT/build/JARVIS.app" "$STAGE/JARVIS.app"
ln -s /Applications "$STAGE/Applications"

# Unsigned local installer: macOS may ask the owner to approve it in Privacy &
# Security. Code signing/notarisation requires the owner's Apple Developer ID.
hdiutil create -volname "JARVIS" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
echo "Built $DMG"
