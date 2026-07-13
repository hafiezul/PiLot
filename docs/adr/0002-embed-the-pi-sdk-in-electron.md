# Embed the Pi SDK in Electron

PiLot will ship on macOS and Windows as an Electron application with a pinned Pi SDK running in the main process. This keeps one cross-platform product and a typed, in-process agent integration; platform-native behavior will be implemented through Electron and OS APIs rather than adding a Rust sidecar or maintaining separate SwiftUI and WinUI clients.
