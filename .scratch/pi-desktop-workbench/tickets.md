# Tickets: PiLot v1 desktop workbench

Build the native macOS workbench defined in [the PiLot v1 specification](spec.md), from bundled Pi engine through unsigned DMG delivery.

Work the **frontier**: any ticket whose blockers are all done.

## Launch the bundled Pi engine

**What to build:** A minimal macOS app that launches the pinned, architecture-correct Node and Pi RPC runtime entirely from its application bundle.

**Blocked by:** None — can start immediately.

- [x] The app launches the bundled Pi RPC runtime on both Apple silicon and Intel without using an installed Node, Pi, npm, PATH lookup, terminal, or PTY.
- [x] Startup performs no package-manager or network operation.
- [x] Build verification checks dependency locks and upstream runtime checksums.
- [x] The running app can display its PiLot, Pi, Node, macOS, and CPU versions.

## Build the native workbench shell

**What to build:** A fixture-backed native workbench matching the selected navigator, focused timeline, pinned interruption, stable composer, and optional trailing inspector interaction model.

**Blocked by:** Launch the bundled Pi engine.

- [x] The project/session navigator, timeline, interruption, composer, and inspector can be exercised with fixture states.
- [x] Waiting, failed, running, and done states use text and icon, with color only supplementary.
- [x] The inspector is toggleable and resizable, hides by default in narrow windows, and never replaces the timeline.
- [x] Standard window, menu, focus, text-editing, and restoration behavior works on macOS 14.

## Open and trust a project

**What to build:** Users can open, drop, and reopen canonical local projects while PiLot enforces Pi project trust before loading project settings or executable resources.

**Blocked by:** Launch the bundled Pi engine; Build the native workbench shell.

- [x] Open panel, drag/drop, and Recents resolve the same directory to one canonical project identity.
- [x] An unknown project receives a native trust explanation before executable project resources load.
- [x] Declining trust opens only the safe read-only surface.
- [x] Reopening restores navigation state without reconstructing in-flight work from UI state.

## Complete one durable coding run

**What to build:** An existing Pi user can create a session, send a text prompt, follow structured activity, and reach a durable settled result through the bundled Pi engine.

**Blocked by:** Open and trust a project.

- [x] The user can choose the effective model and thinking level before sending.
- [x] Assistant output streams in place and interleaved tools correlate by call ID.
- [x] Completion follows `agent_settled`, not an earlier lifecycle event.
- [x] Abort works without confusing it with stopping the session.
- [x] Strict LF-delimited framing retains incomplete bytes and turns malformed or unknown protocol data into a session-local failure without guessing or replaying the prompt.

## Recover an interrupted session

**What to build:** A session interrupted by app or engine failure returns all valid durable work and offers safe recovery without creating a second writer or replaying unfinished work.

**Blocked by:** Complete one durable coding run.

- [x] One exclusive writer lease is enforced across windows and app instances; uncertain ownership requires a fork.
- [x] Valid transcript entries, session metadata, and the saved composer draft survive restart.
- [x] Incomplete trailing data is repaired only after original bytes are preserved.
- [x] Ambiguous or malformed durable data remains preserved with an actionable recovery choice.
- [x] Restart marks unfinished work interrupted and never automatically retries or replays it.

## Supervise concurrent sessions

**What to build:** Users can run and supervise several independent sessions without focus changes or one failed engine disturbing the others.

**Blocked by:** Recover an interrupted session.

- [ ] Multiple sessions continue while unfocused and across project windows.
- [ ] Sessions sort by waiting, failed, running, then done, and by recency within each group.
- [ ] Every session sharing a canonical project root shows a persistent peer/conflict warning without claiming isolation.
- [ ] Killing one engine leaves all other sessions and windows responsive and durable.

## Continue a CLI session by fork

**What to build:** Users can discover CLI history read-only and safely continue a compatible session as a separately owned PiLot session.

**Blocked by:** Recover an interrupted session.

- [ ] CLI sessions show their source and compatibility state without being modified.
- [ ] Continue copies, validates, and migrates staged data before atomic publication.
- [ ] The resulting PiLot session has a new identity, writer lease, controller, process, and session file.
- [ ] Failed continuation publishes no usable session and retains a recovery copy with retry, export, and salvage choices.

## Send rich project context

**What to build:** Users can attach files and images to a prompt through native picker, paste, and drag/drop interactions.

**Blocked by:** Complete one durable coding run.

- [ ] Picked, pasted, and dropped items appear as removable context chips before sending.
- [ ] Supported files and images reach Pi with the submitted prompt.
- [ ] Invalid, missing, or inaccessible context fails clearly without losing the composer draft.
- [ ] Protected-path failures identify the blocked action and relevant system control without requesting broad access preemptively.

## Direct work while a run is busy

**What to build:** Users can steer active work, queue follow-ups, observe retry and compaction, and stop work using Pi's actual run semantics.

**Blocked by:** Complete one durable coding run.

- [ ] Sending while busy requires an explicit steering or follow-up choice.
- [ ] Queued work remains visible and preserves submission order.
- [ ] Retry and compaction activity updates the session state without falsely settling it.
- [ ] Decline, cancel, abort, and Stop Session remain distinct actions.

## Answer Pi and extension interruptions

**What to build:** Users can answer Pi and extension gates, questions, and dialogs through a persistent native interruption surface.

**Blocked by:** Complete one durable coding run.

- [ ] Active requests are pinned above the composer and remain represented at their chronological timeline position.
- [ ] Only choices and persistence scopes supplied by Pi or the extension are presented.
- [ ] Requests remain waiting until answered, cancelled, or timed out; closing a window does not answer them.
- [ ] Waiting state remains visible in the navigator and is announced once without stealing focus.

## Use existing Pi resources

**What to build:** Compatible resources from an existing Pi setup work through the bundled engine, while malformed or unsupported resources degrade independently and explicitly.

**Blocked by:** Open and trust a project; Complete one durable coding run; Answer Pi and extension interruptions.

- [ ] Compatible skills, prompt templates, commands, packages, providers, models, extensions, and custom tools are discoverable and usable through Pi semantics.
- [ ] Invalid resources are isolated individually with their source scope, consequence, and repair action.
- [ ] Extension hooks, providers, commands, gates, tools, and state remain functional when compatible.
- [ ] Unsupported TUI-only or unknown rich presentation falls back to generic structured content and produces one diagnostic per affected surface.
- [ ] PiLot never executes a TUI renderer or silently substitutes an unavailable session model.

## Inspect and hand off changes

**What to build:** Users can inspect current last-run and project changes read-only, then hand files to their existing editor or Finder.

**Blocked by:** Complete one durable coding run.

- [ ] Last-run paths come from structured activity and are labelled as current workspace state, not a historical snapshot.
- [ ] Project inspection shows the current Git working-tree/index difference without pagers, external diff drivers, or writes.
- [ ] Non-Git or unavailable-Git projects show known changed paths and state why an aggregate diff is unavailable.
- [ ] Native textual diffs expose path, status, counts, hunks, and accessible line semantics.
- [ ] Open in Editor follows the usable Pi editor preference or system default; Reveal in Finder works for existing paths.

## Manage project and session navigation

**What to build:** Users can manage project recents and the full PiLot session lifecycle while preserving stable identity and window behavior.

**Blocked by:** Supervise concurrent sessions.

- [ ] Users can create, rename, stop, resume, and archive sessions; archived remains a navigation property rather than a runtime state.
- [ ] Recents, selected session, inspector visibility, and composer drafts restore after reopening.
- [ ] Session identity remains independent of window identity.
- [ ] Another window can observe a live owner read-only without acquiring a second writer.

## Notify only when attention is needed

**What to build:** Opted-in macOS notifications direct inactive users to sessions that need input, failed, or completed.

**Blocked by:** Supervise concurrent sessions; Answer Pi and extension interruptions.

- [ ] Notifications are requested only after the user enables them.
- [ ] Notifications fire only while PiLot is inactive and only for input needed, failure, or completion.
- [ ] Selecting a notification focuses the exact project, session, and active interruption when applicable.
- [ ] Disabled or denied notifications do not impair in-app attention state.

## Report compatibility and reload safely

**What to build:** Users can understand the compatibility of every existing-setup resource, take precise repair actions, and explicitly reload changed resources without corrupting shared state.

**Blocked by:** Continue a CLI session by fork; Use existing Pi resources.

- [ ] Resources report Compatible, Degraded, Action required, or Unsupported with scope, path, consequence, retained state, and next action.
- [ ] The exact tested Pi/CLI matrix gates only unsafe shared-state writes and CLI continuation; PiLot-owned sessions remain usable outside it.
- [ ] Authentication failures expose no secret and link an exact Pi CLI repair or login action.
- [ ] Supported settings changes persist only after the Pi settings manager flushes; failure blocks further writes only to that scope and preserves unknown fields.
- [ ] Resource changes offer reload only after settlement, then rebuild the runtime and subscriptions rather than hot-swapping an active run.

## Export privacy-safe diagnostics

**What to build:** Users can diagnose failures locally and explicitly export a support bundle whose default contents exclude sensitive work and credentials.

**Blocked by:** Recover an interrupted session; Continue a CLI session by fork; Answer Pi and extension interruptions; Report compatibility and reload safely.

- [ ] Actionable diagnostics identify the resource or session, source scope, reason, behavior, retained state, possible loss, recovery copy, and next action.
- [ ] Logs are bounded and redact credentials and environment values.
- [ ] Default support export includes runtime, compatibility, lifecycle, error, and redacted configuration-structure facts only.
- [ ] Automated checks prove default export excludes prompts, responses, files, diffs, tool arguments/results, credentials, environment values, and user-specific raw paths.
- [ ] Raw logs or session content require separate selection and a disclosure warning; nothing uploads automatically.

## Harden native usability and performance

**What to build:** The complete workbench remains accessible, keyboard-operable, and responsive under representative long-session load.

**Blocked by:** Send rich project context; Direct work while a run is busy; Answer Pi and extension interruptions; Use existing Pi resources; Inspect and hand off changes; Manage project and session navigation; Notify only when attention is needed.

- [ ] Keyboard-only walkthroughs pass for opening a project, completing a run, answering an interruption, switching sessions, and reading a diff.
- [ ] VoiceOver exposes meaningful names, states, progress, choices, attachments, changed files, hunks, and lines in those workflows.
- [ ] Text scaling, contrast settings, Reduce Motion, and macOS Keyboard Navigation are honored without relying on color, hover, animation, or position alone.
- [ ] Representative long timelines and diffs preserve selection, scroll position, accessibility order, and responsive typing.
- [ ] Profiling confirms decoding, pipe reads, process waits, Git work, and diff parsing do not stall the main actor; any AppKit adapter is limited to a proven SwiftUI gap.

## Ship and manually update the unsigned app

**What to build:** Existing Pi users can install a universal unsigned PiLot DMG, verify its integrity, check for updates manually, and replace the app without losing PiLot-owned data.

**Blocked by:** Report compatibility and reload safely; Export privacy-safe diagnostics; Harden native usability and performance.

- [ ] A universal unsigned DMG runs on clean Apple silicon and Intel macOS 14 systems.
- [ ] Installation guidance distinguishes checksum integrity from publisher identity and uses Finder Open before any narrowly scoped quarantine-removal fallback.
- [ ] Guidance never recommends disabling Gatekeeper or system-wide security.
- [ ] Check for Updates runs only on user request, displays official HTTPS metadata and release notes, and opens the official download page without downloading or replacing the app.
- [ ] Manual app replacement preserves PiLot-owned sessions, metadata, drafts, recovery copies, and rollback generations.
