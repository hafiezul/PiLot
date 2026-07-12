#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/Runtime/PiEngine"
CACHE="${PILOT_DOWNLOAD_CACHE:-$ROOT/.build/downloads}"
NODE_VERSION=22.19.0

mkdir -p "$CACHE"

install_node() {
  local arch=$1 checksum=$2
  local archive="node-v$NODE_VERSION-darwin-$arch.tar.xz"
  local source="https://nodejs.org/dist/v$NODE_VERSION/$archive"
  local destination="$RUNTIME/node-darwin-$arch"

  if [[ ! -f "$CACHE/$archive" ]]; then
    curl --fail --location --silent --show-error "$source" --output "$CACHE/$archive"
  fi
  echo "$checksum  $CACHE/$archive" | shasum -a 256 --check --status

  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xJf "$CACHE/$archive" -C "$destination" --strip-components=1 "node-v$NODE_VERSION-darwin-$arch/bin/node"
}

# Official Node v22.19.0 SHASUMS256.txt values.
install_node arm64 1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a
install_node x64 41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939

# npm ci rejects lock/package drift and verifies each package's locked integrity.
npm ci --ignore-scripts --omit=dev --prefix "$RUNTIME"
"$ROOT/scripts/verify-runtime.sh"
