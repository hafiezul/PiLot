# Define trust, security, and unsigned distribution

Type: grilling
Status: resolved
Blocked by: 04, 08

## Question

What first-release trust, security, permissions, credential-handling, diagnostics, unsigned-DMG installation, `xattr` guidance, version reporting, and update expectations must the specification define, while leaving signed/notarized distribution for later?

## Answer

PiLot v1 has an explicit trust boundary, not a sandbox. Before loading project-scoped settings or executable resources, an unknown project requires the existing canonical project-trust decision. Once trusted, the bundled Pi engine, extensions, custom tools, and child processes run with the user's normal permissions. The UI states this plainly and exposes a preflight compatibility summary naming loaded executable resources and their source scopes. PiLot faithfully hosts Pi or extension gates but adds no universal per-tool approval system.

PiLot requests macOS permissions only when the corresponding feature is used: notifications are requested when enabled, and protected-path failures explain the blocked operation and link to the relevant System Settings control. It never requires Full Disk Access up front. Filesystem and process access otherwise follow the launching user's permissions.

PiLot never persists, copies, displays, or edits provider credentials. The bundled engine resolves existing Pi `AuthStorage`, environment-backed, and command-backed credentials; login and repair remain explicit Pi CLI handoffs. UI, logs, diagnostics, clipboard actions, and support exports must redact credential values and environment values. No design can guarantee that arbitrary model or tool output contains no secrets, so such content is excluded from diagnostics by default.

Diagnostics are local-first and actionable. Failures show the affected resource or session, source scope, reason, resulting behavior, and next action without secret values. Users may explicitly export a redacted support bundle; nothing is uploaded automatically. The default bundle contains runtime and compatibility metadata, lifecycle/error events, and redacted configuration structure, but excludes prompts, responses, file contents, diffs, tool arguments/results, environment values, and credentials. Raw logs or session content may be attached only through a separate explicit selection with a disclosure warning.

About, compatibility diagnostics, and support exports report the full runtime tuple: PiLot semantic version and build, bundled Pi engine version, bundled Node/runtime version, macOS version, CPU architecture, and detected Pi CLI version plus compatibility state. User-specific paths are omitted or normalized by default.

The unsigned DMG is published only from the product's named official HTTPS release page with a SHA-256 checksum. Documentation must distinguish checksum-based artifact integrity from signed macOS developer identity and must not imply that Gatekeeper verifies the publisher. Installation guidance leads with copying PiLot to Applications and using Finder's Open/context-menu flow. Only if launch remains blocked does it provide the narrow command `xattr -dr com.apple.quarantine /Applications/PiLot.app`, explains exactly what quarantine protection it removes, and warns users to run it only for an artifact downloaded from the official source whose checksum they verified. It never advises disabling Gatekeeper or changing system-wide security policy.

Updates are manual in v1. About and a user-invoked Check for Updates action show the installed version, query the official HTTPS release metadata only on demand, display the available version and release notes, and open the official download page. PiLot performs no background update checks, downloads, self-replacement, or silent migration. Replacing the app preserves PiLot-owned user data subject to the recovery and migration contract; signed/notarized delivery and automatic update infrastructure remain out of scope.
