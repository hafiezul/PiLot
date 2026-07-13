# PiLot v1 Scope

## Release posture

PiLot v1 is an unsigned public preview for macOS arm64 and Windows x64. Releases are versioned manual downloads with published hashes and clear Gatekeeper/SmartScreen instructions. The app may notify users that an update exists but will not self-install until platform signing identities are available.

PiLot collects no analytics and uploads no crash reports. Diagnostics remain local and are exported only by explicit user action.

## Product model

- A **Project** organizes durable **Tasks**.
- Existing compatible Pi sessions appear automatically as tasks.
- Tasks are active or archived; agent inactivity does not mark a task complete.
- A **Run** captures one accepted input through the fully settled agent lifecycle.
- Each task uses either the project's local checkout or a dedicated managed worktree.
- Only one active task may use a project's local checkout at a time.

## Runtime and compatibility

- Electron main process embeds a pinned `@earendil-works/pi-coding-agent` SDK.
- React and TypeScript render the sandboxed desktop UI through a narrow typed preload bridge.
- Pi SDK updates ship only with tested PiLot app releases.
- PiLot uses the canonical `~/.pi/agent` environment for auth, models, agent settings, resource trust, compatible resources, and sessions.
- PiLot-created tasks remain standard Pi JSONL sessions resumable by a compatible Pi CLI.
- Namespaced Pi `custom` entries store task metadata outside model context.
- Unknown newer session schemas are never rewritten and require a PiLot update.
- An externally modified open session pauses and requires explicit reload or fork.
- Unexpectedly stopped runs reopen as interrupted and are never replayed automatically.

## Authentication and trust

- A complete desktop provider UI supports existing credentials, OAuth/device flows, API-key setup, status, reauthentication, and logout against canonical Pi auth storage.
- Canonical Pi resource-trust decisions are reused and updated.
- Separate remembered project-level consent is required before granting an agent command and file access.
- After consent, Pi runs without per-command approval prompts.
- User extensions do not execute in v1.

## Concurrent execution

- Several user-created tasks may run concurrently; child-agent orchestration is deferred.
- A configurable global cap defaults to four active runs; excess starts queue.
- Closing the last window with active runs asks whether to continue in the background or stop cleanly.
- Native notifications appear for attention events only while PiLot is unfocused or backgrounded.

## Worktrees

- A task may run Local or in a PiLot-managed Git worktree.
- New worktrees start from a selected committed branch or commit only.
- Dirty local changes and ignored files are not transferred.
- A trusted project may define one optional explicit setup command; PiLot never infers setup.
- Completed work can be reviewed, turned into a branch in place, or opened in the user's editor or terminal.
- Bidirectional Local/Worktree Handoff is deferred.
- Worktree cleanup is explicit; dirty worktrees cannot be silently removed.

## Shared Pi features

Included:

- Models, scoped models, thinking levels, retry, compaction, and context/cost usage
- Context files, skills, and prompt templates
- Image paste/drop/picker and project file references
- Steering and follow-up queues
- User `!` and `!!` commands as inline command blocks
- Session naming, labels, forks, clones, branch navigation, and local export
- Reload of supported Pi resources

Not translated directly:

- Built-in TUI commands become native menus, screens, and command-palette actions.
- Pi TUI themes and keybindings do not style or configure the desktop UI.
- TUI headers, footers, editors, overlays, widgets, and custom renderers have no React conversion layer.

## Interface

- One command-center window with native OS title bar and application menus
- Adaptive three-pane shell:
  1. Project and task navigation
  2. Focused task or attention overview
  3. Collapsible Changes, History, and Details inspector
- Inspector badges update without stealing focus or changing tabs.
- Launch opens a compact cross-project attention overview.
- Task transcripts use a run-centric timeline rather than chat bubbles.
- Thinking is collapsed by default.
- Successful tools are summarized; failures and attention requests expand automatically.
- Changes are read-only aggregate Git diffs with open-in-editor actions.
- No integrated terminal or inline code editor.
- Composer uses contextual controls, including execution location before start and explicit Steer/Follow-up delivery while running.
- Desktop actions live in native menus and a command palette; skills and prompt templates retain slash completion.
- Appearance follows the OS by default with Light and Dark overrides.
- Keyboard shortcuts use a fixed platform-conventional map and remain discoverable through menus and the command palette.
- First launch performs a readiness check instead of showing a tutorial carousel.

## Accessibility

PiLot targets WCAG 2.2 AA with complete keyboard operation, visible focus, screen-reader semantics, compliant contrast, scalable text, non-color state cues, and reduced-motion support.

## Explicitly deferred

- User extensions
- Full terminal and code editor
- Scheduled or unattended automations
- Child agents
- Full Local/Worktree Handoff and dirty-state transfer
- Automatic worktree snapshot, eviction, or restoration
- Multiple application windows
- Network transcript sharing
- Arbitrary shortcut remapping
- Signed self-updates until platform credentials exist
- macOS x64 and native Windows arm64 builds
