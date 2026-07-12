# Define existing setup compatibility contract

Type: grilling
Status: resolved
Blocked by: 01, 02, 04

## Question

What exact first-release compatibility contract should PiLot make for existing authentication, providers/models, settings, skills, prompts, sessions, extensions, custom tools, themes, and keybindings—including detection, unsupported cases, degradation, and user-visible diagnostics?

## Answer

PiLot's first release is **reuse-first, not import-first**: for a trusted project it uses the existing Pi setup through the bundled, release-pinned Pi engine, preserves supported engine behavior, and blocks only unsafe operations. It does not copy configuration into a second editable setup or promise terminal-presentation compatibility.

### Compatibility states

Every detected resource reports one of four states in a persistent compatibility summary:

- **Compatible** — loaded with its Pi engine behavior preserved, possibly through native presentation.
- **Degraded** — safe backend behavior remains, but an unsupported presentation or optional capability is omitted with a named fallback.
- **Action required** — the current operation is blocked until the user repairs or confirms something.
- **Unsupported** — PiLot intentionally does not load or map the resource in v1.

Normal work is not interrupted for informational or degraded states. PiLot shows an inline explanation and recovery action only when the current action is blocked. Diagnostics identify the resource, scope and source path, reason, resulting behavior, and next action, without exposing credential values.

### Version boundary and detection

The bundled Pi engine is authoritative. Each PiLot release publishes an exact tested matrix; v1 guarantees at least the installed CLI version exactly matching its bundled engine and infers nothing from semver alone. PiLot preflights the installed CLI version, trust state, Pi manager/resource-loader diagnostics, configuration parse errors, session metadata/model availability, and extension load errors. Dynamic extension incompatibility is detected at runtime because arbitrary TypeScript cannot be classified reliably in advance.

Outside the tested CLI matrix, PiLot remains usable with its own sessions. Read-only setup discovery remains available, but writes to shared Pi state and continuation of CLI sessions are **Action required** until compatibility is restored. PiLot never silently migrates shared CLI-owned data across an untested version boundary.

### Per-resource contract

| Existing Pi resource | First-release promise | Failure or degradation |
|---|---|---|
| Authentication | Reuse `AuthStorage` and existing provider credentials without copying or displaying secrets. | Missing, expired, unresolved environment/command-backed, refresh, or lock failures are **Action required**. PiLot gives the exact guided Pi CLI repair/login step and rechecks afterward; it has no native credential editor in v1. |
| Providers and models | Load built-ins, `models.json`, and extension-registered providers through Pi. Treat user model configuration as read-only. | Invalid custom configuration is isolated and diagnosed while valid built-ins remain. If a session's model is unavailable, PiLot pauses before the next prompt and requires the user to confirm a replacement; no silent fallback. |
| Settings | Read global and trusted-project settings through `SettingsManager`. Persist only explicit user-initiated Pi engine setting changes through that manager; PiLot UI preferences remain app-owned. | Parse, lock, flush, or persistence errors block further shared writes and remain visible until repaired. PiLot never overwrites whole settings files or drops unknown fields. |
| Skills and prompts | Discover and invoke compatible global, project, and installed-package resources through Pi, preserving Pi expansion and command semantics. | A malformed or unloadable resource is skipped individually and diagnosed; unrelated resources and sessions continue. |
| Sessions | Discover CLI sessions read-only and fork them into PiLot's session store before continuation. Each live PiLot session has one managed writer; PiLot never writes a CLI-owned session in place. | Untested versions, unreadable/corrupt input, or an unavailable recorded model block continuation with an explicit action. Migration and recovery mechanics are deferred to **Define state recovery and migration behavior**. |
| Extensions | Load trusted extensions under the bundled engine. Preserve lifecycle hooks, providers, commands, tool gates, custom tools, state, and RPC-supported dialogs/notifications. | Unsupported TUI-only presentation degrades per extension rather than disabling the whole extension: PiLot ignores the unsupported hook, preserves safe backend behavior, uses generic custom-message/tool/data views, and reports one actionable diagnostic per extension/surface. Fatal extension load errors disable that extension for the session, not PiLot. |
| Custom tools | Execute tools registered by compatible trusted extensions with Pi's normal full user permissions and lifecycle. | Unknown rich renderers fall back to a generic view of tool name, arguments, content/details, progress, and errors. TUI renderers are never executed or scraped for display. |
| Themes and keybindings | Detect and list them for transparency. | They are **Unsupported** for import: terminal palettes, chords, extension shortcuts, and editor behavior do not override native appearance, menus, text editing, accessibility, or macOS shortcuts. |
| Pi packages | Reuse already-installed compatible package resources. | Install, update, and removal stay in Pi CLI for v1. PiLot detects resulting changes and offers reload; it does not mutate package trees beneath live runtimes. |

Saved canonical project-trust decisions are honored. Unknown projects receive a native trust decision before project settings or executable resources load; PiLot never silently approves them.

Each live runtime snapshots settings, models, skills, prompts, extensions, and package resources. On disk changes, PiLot detects them and offers an explicit reload after the session settles; it does not hot-swap resources into an active run. Reload rebuilds the runtime and subscriptions through Pi's lifecycle.
