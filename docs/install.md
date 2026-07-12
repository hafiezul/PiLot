# Install and update PiLot

PiLot is distributed as an **unsigned universal macOS 14+ app** from the [official release page](https://github.com/hafiezul/PiLot/releases). It contains Apple silicon and Intel executables.

## Verify the download

Download the DMG and its `.sha256` file into the same folder, then run:

```sh
cd ~/Downloads
shasum -a 256 -c PiLot-0.1.0-universal.dmg.sha256
```

A matching SHA-256 proves that the downloaded bytes match the published file. It does **not** establish a signed developer identity; this release has no Developer ID signature or Apple notarization.

## Install

1. Open the DMG and drag PiLot to Applications.
2. In Finder, open Applications, Control-click PiLot, choose **Open**, then confirm **Open**.

Use that Finder flow first. If macOS still blocks an official-source download whose checksum you verified, remove quarantine from this app only:

```sh
xattr -dr com.apple.quarantine /Applications/PiLot.app
```

This removes macOS quarantine protection from PiLot. Do not run it unless the app came from the official release page and its checksum matched. PiLot never requires disabling Gatekeeper or any system-wide security setting.

## Check for and install updates

Choose **PiLot → Check for Updates…**. PiLot queries the [official HTTPS metadata](https://github.com/hafiezul/PiLot/releases/latest/download/update.json), displays its release notes, and can open the official release page. It does not check in the background, download an update, or replace itself.

To update, quit PiLot, download and verify the new DMG, then replace `/Applications/PiLot.app`. Sessions, metadata, composer drafts, recovery copies, and rollback generations remain under `~/Library/Application Support/PiLot/`; replacing the app does not remove them.

## Release metadata format

Each release publishes `update.json` beside the DMG:

```json
{
  "version": "0.1.0",
  "releaseNotes": "Initial unsigned PiLot release."
}
```
