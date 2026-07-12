# PiLot v1 product, UX, and technical specification

Status: Decision-ready  
Date: 2026-07-12  
Evidence baseline: Pi `v0.80.6`

## 1. Product definition

PiLot is an unsigned, macOS-first desktop workbench for existing Pi users. It opens local projects, runs and supervises multiple Pi coding sessions, presents Pi activity through native macOS interactions, and hands editing and Git delivery back to the user's existing tools.

PiLot is neither a chat wrapper nor an IDE. Pi remains authoritative for the agent loop, models, tools, resources, extension behavior, and session transcript. PiLot owns native presentation, process supervision, project/session navigation, app preferences, compatibility reporting, and recovery orchestration.

### Target user

An existing Pi user who already has authentication, providers, models, settings, skills, prompts, extensions, packages, and session history, and wants a visual way to run and supervise coding work without abandoning that setup.

### Success criteria

A user can:

1. Open a trusted existing project and understand any compatibility problem before work starts.
2. Complete a coding turn from prompt through inspection and external-editor handoff.
3. Run several independent sessions, identify the one needing attention, and respond without disturbing the others.
4. Discover a CLI session, fork it safely, and continue in PiLot without creating a second writer.
5. Recover all valid durable session data after app or engine interruption without automatic prompt replay.

## 2. Product principles

- **Reuse first:** use compatible existing Pi setup in place; do not import it into a second editable configuration.
- **One proven writer:** one live process owns each PiLot session file; CLI session files are read-only sources.
- **Native presentation:** preserve Pi semantics, not Pi TUI pixels, chords, themes, or components.
- **Explicit degradation:** unsupported presentation never masquerades as compatibility.
- **Preserve, then repair:** retain original bytes and automate only lossless, unambiguous recovery.
- **Attention over overview:** waiting and failed sessions rise above routine running or completed work.
- **No implied sandbox:** trusted Pi code and tools run with the user's normal permissions.

## 3. Domain model

- **Project:** a local directory opened in PiLot. A canonical path identifies it for trust, navigation, and shared-root warnings.
- **Session:** one Pi transcript plus PiLot metadata. A live PiLot session has one controller, one RPC engine process, and one exclusively owned session file.
- **CLI session:** a session discovered in Pi's existing store. PiLot may inspect it read-only and must fork it before continuation.
- **Run:** work from one submitted prompt until Pi reports `agent_settled`, including retries, compaction, tools, steering, and queued follow-ups.
- **Interruption:** a Pi or extension request that requires user input, including a gate, question, dialog, or compatibility action.
- **Activity:** structured model, tool, lifecycle, retry, compaction, or error output shown in a session timeline.
- **Compatibility state:** `Compatible`, `Degraded`, `Action required`, or `Unsupported` for a detected resource.
- **Recovery copy:** preserved source bytes or a staged copy retained because validation, migration, import, or repair did not complete safely.

## 4. Scope

### Included

- macOS 14 or later on Apple silicon and Intel Macs.
- Open, drop, reopen, and list recent local projects; canonical Pi project trust.
- Create, rename, stop, resume, and archive PiLot sessions.
- Read-only discovery and forked continuation of CLI sessions.
- Concurrent sessions, including sessions sharing a project root with persistent conflict warnings.
- Text, image, and file-context prompting.
- Pi model and thinking-level selection; steering, follow-up, queues, abort, retry, and compaction status.
- Discovery and invocation of compatible skills, prompt templates, and extension commands.
- Structured assistant, tool, extension-dialog, progress, error, and diagnostic presentation.
- Read-only last-turn and workspace changed-file/diff inspection.
- Open in Editor and Reveal in Finder handoffs.
- Opt-in macOS notifications while PiLot is inactive for input needed, failure, and completion.
- Existing-setup compatibility summary and precise Pi CLI repair handoffs.
- Local redacted diagnostics and explicit support-bundle export.
- Unsigned DMG installation and manual update checking.

### Non-goals

- New-Pi-user onboarding or native login, credential, provider, package, extension, skill, or prompt management.
- A comprehensive Pi settings editor.
- Pi TUI embedding, scraping, parity, terminal themes/keybindings, or arbitrary TUI extension UI.
- Session-tree editing, fork-from-message, branch cloning, labels/bookmarks, export/share, or manual history surgery.
- Managed worktrees, workspace isolation, overlap detection, conflict prevention, or merge resolution.
- Embedded editor, terminal, browser, preview server, or general IDE surface.
- Editing diffs or performing Git stage, revert, commit, branch, merge, rebase, push, or pull-request operations.
- A PiLot-wide universal permission system. Only Pi- or extension-defined gates are hosted.
- Signing, notarization, App Store delivery, automatic updates, Windows, or Linux in v1.

## 5. Information architecture and interaction model

PiLot uses the selected [Navigator + inspector prototype](prototype/workbench-interactions/index.html):

```text
Project/session source list | Focused session timeline | Optional changes inspector
                            | Pinned interruption       |
                            | Stable composer           |
```

- Projects contain sessions in the source list.
- Within a project, sessions sort by attention group—waiting, failed, running, done—then by recency.
- Every session state uses text and an icon; color is supplementary.
- Selecting a running session changes focus only; it does not pause or stop work.
- One focused timeline keeps user and assistant prose prominent. Routine successful activities are collapsed; failures and interruptions are expanded.
- Active interruptions are pinned immediately above the composer and remain represented at their chronological timeline position.
- The composer remains available while work runs. Sending while busy must explicitly use Pi steering or follow-up semantics; PiLot does not invent concurrent prompt behavior.
- The trailing inspector is user-toggleable and resizable. Narrow windows hide it by default; it never replaces the timeline or becomes a detached utility window in v1.

### Required session states

- **Running:** a run, retry, compaction, tool, steering item, or follow-up remains active.
- **Waiting for approval:** an extension-defined gate awaits a choice.
- **Waiting for answer:** a Pi/extension dialog or question awaits input.
- **Failed:** a nonrecoverable run error, protocol failure, or engine exit needs action.
- **Done:** Pi reported `agent_settled` and no interruption or queued work remains.

`Archived` is a navigation property, not a runtime state. A compatibility block appears as `Action required` and prevents only the affected operation.

## 6. Core workflows

### Open or reopen a project

1. The user chooses a folder through the native open panel, drag/drop, or Recents.
2. PiLot canonicalizes the path and checks the saved Pi trust decision before loading project settings or executable resources.
3. An unknown project receives a native trust explanation. Declining opens only the safe, read-only surface and does not load executable project resources.
4. PiLot preflights the runtime tuple, setup resources, and actionable failures.
5. Compatible projects open directly. A block names its resource, scope/path, consequence, and exact next action.
6. Reopening restores navigation, selected session, inspector visibility, and saved composer drafts, but never recreates in-flight work from UI state.

### Start a new session

1. The user selects a project and creates a session.
2. PiLot shows the effective model and thinking level; the user may change either before sending.
3. Text, dropped/picked files, and pasted/dropped images appear as removable context chips.
4. Sending launches the project's pinned-resource runtime if needed and submits through Pi RPC.
5. Assistant text streams in place; tool activity updates by call ID; the main actor remains responsive.
6. At settlement, PiLot updates changed files and offers inspector, editor, and Finder handoffs.

### Continue a CLI session

1. PiLot lists CLI history as read-only and identifies its source and compatibility state.
2. Continue stages a copy into PiLot's store, validates and migrates the copy through the bundled engine, then atomically publishes it.
3. The source is never modified. A failed fork publishes no usable session and retains a recovery copy.
4. The new PiLot session receives its own identity, writer lease, controller, and process.

### Supervise parallel sessions

- Sessions continue when not focused and when other project windows are active.
- A shared canonical project root is persistently identified on every affected session, with links/names for peers and a warning that edits may conflict.
- PiLot neither blocks shared-root execution nor claims to isolate it.
- System notifications fire only when enabled and PiLot is inactive; selecting one focuses the relevant session and interruption.

### Handle approval or question

- PiLot renders only the choices and persistence scopes supplied by Pi or the extension.
- Decline/cancel and Stop Session remain distinct.
- Timeouts and cancellation are preserved. Closing a window does not answer an interruption.
- A request remains pinned and reflected in sidebar/window attention until answered, cancelled, or timed out.

### Inspect and hand off changes

- **Last turn** lists paths observed as changed by structured tool results during the latest run and shows their current workspace diff. It is labelled as current state, not a historical snapshot; with shared-root sessions, peer changes may be present.
- **Workspace** is the current Git working-tree/index difference for the project. For a non-Git project or unavailable Git, PiLot shows changed paths known from Pi activity and states that an aggregate diff is unavailable.
- Git inspection is read-only and disables external diff drivers and pagers. It never stages, rewrites, or cleans files.
- Selecting a file shows a native textual diff with path, status, additions/deletions, hunk labels, and accessible line semantics.
- Open in Editor uses the configured existing Pi editor preference when usable, otherwise the system default application; Reveal in Finder is always available for existing paths.

## 7. Existing Pi compatibility contract

The bundled engine is authoritative. Every PiLot release publishes an exact tested tuple and CLI compatibility matrix; v1 guarantees at least an installed CLI version exactly matching the bundled Pi version. Compatibility is never inferred from semver alone.

Outside the tested CLI matrix, PiLot's own sessions remain usable. Setup discovery remains read-only, while shared-state writes and CLI-session continuation are `Action required` until compatibility is restored.

| Resource | v1 behavior | Failure/degradation |
|---|---|---|
| Authentication | Reuse Pi `AuthStorage`; never copy, display, or edit secrets. | Missing/expired credentials, unresolved env/command keys, refresh, or lock failure blocks the request and links an exact Pi CLI repair/login step. |
| Providers/models | Load built-ins, `models.json`, and extension providers through Pi; user model config is read-only. | Isolate invalid custom config. An unavailable session model pauses before the next prompt and requires confirmed replacement; no silent fallback. |
| Settings | Read global and trusted-project settings with `SettingsManager`; save only explicit supported Pi changes through it. App preferences remain separate. | Parse/lock/flush failures mark the change unsaved and block further writes only to that scope. Never overwrite whole files or drop unknown fields. |
| Skills/prompts | Use Pi discovery, expansion, arguments, and command semantics. | Skip malformed resources individually and diagnose them. |
| Sessions | Discover CLI sessions read-only; fork before continuation. One writer per PiLot session file. | Untested schema/version, corruption, or unavailable model blocks continuation with recovery actions. |
| Extensions | Run trusted compatible extensions under the bundled engine; preserve hooks, providers, commands, gates, tools, state, and RPC dialogs. | Ignore unsupported TUI-only presentation, use generic message/tool/data views, and report one diagnostic per extension/surface. Fatal load failure disables that extension for the session. |
| Custom tools | Execute through Pi with normal user permissions and lifecycle hooks. | Unknown rich rendering falls back to name, arguments, content/details, progress, and errors. Never execute TUI renderers. |
| Themes/keybindings | Detect and list for transparency. | `Unsupported` for import; native appearance, menus, editing, accessibility, and shortcuts are authoritative. |
| Pi packages | Load already-installed compatible package resources. | Install/update/remove remains in Pi CLI. Detect changes and offer reload only after the session settles. |

Each live engine snapshots its settings, models, skills, prompts, extensions, and packages. File changes produce an explicit reload offer; reload settles the run, shuts down the old runtime, and rebuilds the process and subscriptions. No resource is hot-swapped into an active run.

## 8. Architecture

### Platform and UI

- SwiftUI-first macOS 14+ app.
- `NavigationSplitView` for source list/detail, SwiftUI `inspector` for changes, `WindowGroup` for restorable project/session windows, and `Commands` for menu actions.
- Narrow `NSViewRepresentable` AppKit adapters are permitted only after profiling or accessibility testing proves a SwiftUI gap, such as rich text editing or a long mixed-height timeline.
- No WebView, local HTTP server, embedded browser UI, Electron/Tauri layer, XPC helper, daemon, database, generic plugin bus, or PTY.

### Process model

```text
PiLot native process
├─ app coordinator and PiLot-owned index
├─ main-actor native presentation
├─ SessionController actor A ─ JSONL/stdin/out ─ bundled Pi RPC A ─ session A
└─ SessionController actor B ─ JSONL/stdin/out ─ bundled Pi RPC B ─ session B
```

Each `SessionController` actor exclusively owns one Foundation `Process`, stdin/stdout/stderr pipes, request IDs, pending responses, strict receive buffer, lifecycle, and writer lease. It publishes immutable/coalesced UI state to a main-actor view model. Pipe reads, JSON decoding, process waits, Git inspection, and diff parsing never run on the main actor.

Launch uses bundle-relative Node and Pi entry-point paths, an explicit PiLot-owned session path, project cwd, resolved startup environment, trust override, and `--mode rpc`. It never discovers or shells through the user's `pi`, `node`, `npm`, PATH, Terminal, or a PTY.

### Runtime packaging and versioning

- Bundle the locked Pi production dependency tree and matching Node runtime under `PiLot.app/Contents/Resources/PiEngine`.
- The evidence baseline is Pi `v0.80.6`, which requires Node `>=22.19.0`; implementation planning may advance the pair only as one tested, release-pinned tuple.
- Universal distribution includes upstream arm64 and x64 Node executables and selects the running architecture.
- Build automation verifies dependency lockfiles and upstream checksums. Runtime startup performs no package-manager or network operation.
- Pi and Node update only with a PiLot release.

### RPC transport

- Parse stdout as protocol-only LF-delimited JSON: split only byte `0x0A`, retain incomplete bytes, decode complete UTF-8 records, and correlate responses by ID.
- Treat unknown or malformed protocol data as a session-local compatibility failure; never guess through desynchronization.
- Correlate interleaved tools by call ID and completion by `agent_settled`, not `agent_end`.
- Keep stderr separate, bounded, and redacted.
- On normal stop, request abort if active, close stdin, wait briefly, then terminate the root process if needed and record an unclean stop.
- On unexpected exit, reject pending requests, preserve durable files, mark only that session interrupted, and offer explicit restart. Never replay the in-flight prompt.

### Startup environment

Once per app launch:

1. Start with the inherited environment.
2. Best-effort query the user's absolute, validated login shell from the home directory with a fixed, non-project-interpolated command that emits a marker plus `/usr/bin/env -0`; enforce a short timeout.
3. Merge the result, remove `DYLD_*`, `NODE_OPTIONS`, and `NODE_PATH`, and overwrite PiLot-owned launch values.
4. If capture fails, continue with the inherited environment and report one compatibility diagnostic. Missing provider values follow the normal auth contract.

The shell is used only for environment capture, never to launch Pi.

### App-owned storage

Use `~/Library/Application Support/PiLot/` for the project/session index, PiLot session files, metadata, drafts, leases, migrations, rollback generations, and recovery copies. Use `~/Library/Logs/PiLot/` for bounded redacted diagnostics and the system caches directory for disposable derived indexes. Pi session JSONL remains the canonical transcript; the PiLot index is rebuildable and never replaces it.

Persistent app-owned files use atomic replacement and retain a last-known-good copy. Session identity is stable and independent of window identity. Canonical project paths, not display names, determine shared-root warnings.

## 9. Trust, permissions, privacy, and diagnostics

### Trust and execution

Before project settings or executable project resources load, unknown projects receive Pi's canonical trust decision. A trusted runtime, extension, custom tool, and child process runs with the launching user's normal permissions. The process boundary contains crashes; it is not a security sandbox. The compatibility summary names loaded executable resources and source scopes.

PiLot requests notifications only when enabled and never requests Full Disk Access preemptively. A protected-path failure names the blocked action and links the relevant System Settings control.

### Credentials and sensitive content

PiLot never stores, copies, displays, logs, or edits provider credentials or environment values. The bundled Pi engine resolves `AuthStorage`, environment-backed, and command-backed credentials. Arbitrary prompts, model output, files, diffs, and tool data may themselves contain secrets, so all are excluded from diagnostics and support bundles by default.

### Diagnostics

Every actionable diagnostic identifies the resource/session, source scope and normalized path, reason, resulting behavior, durable state retained, possible loss, recovery copy if any, and next action. Credential and environment values are always redacted.

Support export is explicit and local. Its default bundle includes the runtime tuple, compatibility metadata, lifecycle/error events, and redacted configuration structure; it excludes prompts, responses, files, diffs, tool arguments/results, environment values, credentials, and user-specific raw paths. Adding raw logs or session content requires separate selection and a disclosure warning. Nothing uploads automatically.

## 10. Durability, recovery, migration, and ownership

### Durable guarantee

For every PiLot session, recover all valid persisted Pi entries, PiLot session metadata, and the saved composer draft. Unpersisted stream fragments may be lost. An interrupted prompt/tool call is marked interrupted and is never retried or replayed automatically.

### Writer ownership

- Each PiLot session has one exclusive writer lease across windows and app instances.
- A live owner may be focused or observed read-only elsewhere.
- Reclaim a stale lease automatically only when owner death is proven.
- If ownership is uncertain, require consent to fork; never force ownership.
- CLI session sources remain read-only.

### Automatic repair

After preserving original bytes, PiLot may automatically:

- remove an incomplete trailing JSONL fragment;
- rebuild derived indexes/metadata from canonical durable data;
- complete or remove an interrupted temporary-file commit only when the intended state is unambiguous.

Malformed durable records, conflicting trees, or uncertain commits require action. Recovery never mutates the original in place; with consent it creates a new session from verified entries and discloses every gap. Read-only export remains available.

### Imports and migrations

- Fork/import: copy source → validate and migrate copy with bundled engine → atomically publish. Failure retains a diagnostic recovery copy and offers retry, export, or consent-based salvage.
- Schema migration: only inactive PiLot-owned sessions; copy → migrate → verify → atomic replace. Retain the pre-migration original for rollback.
- Lossy, unsupported, or unverifiable migration requires consent. Newer unsupported schema is read-only; never downgrade-write it.
- Keep failed-operation recovery copies until successful retry supersedes them or the user explicitly discards them.
- Keep at least one rollback generation after successful migration and save; a newer verified generation may supersede it.

Shared Pi settings save only after `SettingsManager.flush()` succeeds. Failure leaves sessions running, marks the attempted change unsaved, and blocks further writes only to that settings scope until retry or discard.

## 11. Native behavior and accessibility requirements

- Ordinary document-style windows, titlebars, toolbars, source lists, sheets, alerts, file panels, menus, context menus, drag/drop, light/dark appearance, and window restoration.
- File, Edit, View, Session, Window, and Help menus. At minimum: New Window, Open Project, New Session, Close, Find, Focus Sidebar, Focus Composer, Show/Hide Inspector, Stop Session, Settings, Check for Updates, and Help.
- Menu availability follows focused state. Standard macOS text editing, undo, selection, IME, Services, and clipboard behavior remain intact.
- Return sends; Shift-Return inserts a newline. No hidden terminal chord is required for a primary action.
- Keyboard-only access and logical focus order for project/session navigation, timeline, activity disclosures, interruptions, composer, and diff inspector.
- VoiceOver names project/session state, activity verb/target/status, progress, approval choices/scopes, attachments, changed files, and diff lines/hunks. Status never relies on color, hover, animation, or spatial position alone.
- Stream updates are coalesced and announced without repeatedly stealing focus. Waiting/failed transitions may announce once; routine token deltas do not.
- Support text scaling, sufficient contrast, Reduce Motion, Increase Contrast, and keyboard-navigation settings.
- Virtualize long timelines and diffs while preserving selection, scroll position, accessibility order, and responsive typing.

## 12. Distribution, installation, versions, and updates

- Publish the unsigned DMG only from PiLot's named official HTTPS release page with a SHA-256 checksum.
- Documentation must distinguish checksum integrity from signed developer identity and must not claim Gatekeeper verifies the publisher.
- Primary installation: copy PiLot to Applications, then use Finder Open/context-menu Open.
- Only if still blocked, document `xattr -dr com.apple.quarantine /Applications/PiLot.app`, explain that it removes quarantine protection, and require official-source download plus checksum verification. Never advise disabling Gatekeeper or system-wide security.
- About, compatibility diagnostics, and support export report PiLot semantic version/build, bundled Pi version, bundled Node version, macOS version, CPU architecture, and detected Pi CLI version/state.
- Updates are manual. User-invoked Check for Updates queries official HTTPS metadata, shows version/release notes, and opens the official download page. No background check, download, self-replacement, or silent migration.

## 13. Implementation-planning gates

Implementation planning must sequence work so these gates pass before broad feature development:

1. Package and launch the pinned arm64/x64 Node + Pi RPC runtime without installed Node or Pi.
2. Reproduce the selected navigator, timeline, pinned interruption, composer, and inspector in a native macOS 14 shell.
3. Prove strict RPC framing, correlated interleaved tools, `agent_settled`, abort, malformed-stream isolation, and no automatic replay.
4. Prove one-writer leases, staged CLI fork, interrupted-tail repair, rollback migration, and recovery-copy retention with failure injection.
5. Kill one of several engines and confirm all other sessions/windows remain responsive and durable.
6. Stream a representative long session while typing and scrolling without main-actor stalls.
7. Pass keyboard and VoiceOver walkthroughs for opening a project, completing one turn, answering an interruption, switching sessions, and reading a diff.
8. Verify compatibility states and generic extension/tool fallbacks against the published exact Pi/CLI/resource matrix.
9. Verify default diagnostics/support export contain none of the excluded content or values.
10. Build the unsigned DMG, verify checksum instructions on a clean macOS 14 machine, and test manual replacement without loss of PiLot-owned data.

A failed UI gate changes only the measured surface, potentially to a narrow AppKit adapter. A failed protocol, ownership, recovery, or trust gate blocks release planning; those guarantees may not be weakened to preserve schedule.

## 14. Evidence and design assets

- [Pi runtime and shared-state integration research](research/pi-runtime-and-shared-state.md)
- [Pi TUI-to-desktop capability matrix](research/pi-tui-to-desktop-capability-matrix.md)
- [Native agent workbench comparison](research/native-agent-workbench-patterns.md)
- [macOS desktop architecture options](research/macos-desktop-architecture.md)
- [Interactive workbench prototype](prototype/workbench-interactions/index.html) (`variant=A` is selected)

These assets explain the alternatives and primary-source evidence. This specification is authoritative when an asset describes an option that was later rejected.
