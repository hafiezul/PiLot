#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/.build/PiLot.app"
"$ROOT/scripts/build-app.sh"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
OUTPUT="$ROOT/.build/release"
STAGING="$OUTPUT/dmg-root"
DMG="$OUTPUT/PiLot-$VERSION-universal.dmg"

[[ "$(lipo -archs "$APP/Contents/MacOS/PiLot")" == *arm64* ]]
[[ "$(lipo -archs "$APP/Contents/MacOS/PiLot")" == *x86_64* ]]
SIGNATURE=$(codesign -dv "$APP" 2>&1)
grep -q 'Signature=adhoc' <<<"$SIGNATURE"
grep -q 'TeamIdentifier=not set' <<<"$SIGNATURE"

rm -rf "$STAGING" "$DMG" "$DMG.sha256"
mkdir -p "$STAGING"
ditto "$APP" "$STAGING/PiLot.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -quiet -fs HFS+ -format UDZO -volname PiLot -srcfolder "$STAGING" "$DMG"
rm -rf "$STAGING"
(cd "$OUTPUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

printf '%s\n%s\n' "$DMG" "$DMG.sha256"
