#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/Runtime/PiEngine"

node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync(process.argv[1]));
const manifest = JSON.parse(fs.readFileSync(process.argv[2]));
const wanted = manifest.dependencies["@earendil-works/pi-coding-agent"];
const locked = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
if (lock.lockfileVersion !== 3 || wanted !== "0.80.6" || locked.version !== wanted || !locked.integrity) process.exit(1);
' "$RUNTIME/package-lock.json" "$RUNTIME/package.json"

for arch in arm64 x64; do
  test -x "$RUNTIME/node-darwin-$arch/bin/node"
  [[ "$(lipo -archs "$RUNTIME/node-darwin-$arch/bin/node")" == "$arch" ]]
done

test -f "$RUNTIME/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
npm ls --omit=dev --prefix "$RUNTIME" >/dev/null
