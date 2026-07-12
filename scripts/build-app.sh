#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/.build/PiLot.app"

"$ROOT/scripts/prepare-runtime.sh"
swift build --package-path "$ROOT" -c release --arch arm64 --arch x86_64
BINARY=$(swift build --package-path "$ROOT" -c release --arch arm64 --arch x86_64 --show-bin-path)/PiLot

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/PiLot"
ditto "$ROOT/Runtime/PiEngine" "$APP/Contents/Resources/PiEngine"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>PiLot</string>
  <key>CFBundleExecutable</key><string>PiLot</string>
  <key>CFBundleIdentifier</key><string>dev.pi.pilot</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>PiLot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "$APP"
