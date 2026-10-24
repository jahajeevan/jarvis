#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/JARVIS.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"

# The installed app cannot rely on the original Git checkout still existing.
# Bundle the local web face, bridge, and locked dependencies, while explicitly
# excluding Git history, previous builds, and user-local configuration/secrets.
RUNTIME="$APP/Contents/Resources/jarvis-runtime"
rsync -a --delete \
  --exclude '/.git/' \
  --exclude '/build/' \
  --exclude '/dist/' \
  --exclude '/.env.local' \
  --exclude '/.DS_Store' \
  "$ROOT/" "$RUNTIME/"
cp "$ROOT/macos/runtime.env.local" "$RUNTIME/.env.local"

# A hand-authored vector mark, rasterised by macOS tooling for the app bundle.
ICONSET="$ROOT/build/JARVIS.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$ROOT/macos/JARVIS.svg" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$ROOT/macos/JARVIS.svg" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/JARVIS.icns"

swiftc "$ROOT/macos/JARVISApp.swift" \
  -o "$APP/Contents/MacOS/JARVIS" \
  -parse-as-library \
  -framework SwiftUI \
  -framework WebKit

echo "Built $APP"
echo "Open it with: open \"$APP\""
