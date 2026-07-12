# Define MVP workflows and boundaries

Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

Which user jobs, end-to-end workflows, and Pi capabilities belong in the unsigned macOS MVP specification, and which should be explicitly deferred, so the product is a coherent visual workbench rather than a broad TUI clone?

## Answer

The MVP is a **desktop workbench for running coding work and supervising parallel Pi sessions**, not a native replacement for every Pi TUI surface. Its coherent loop is: open an existing project, start or resume work, direct one or more sessions, respond when they need attention, inspect what happened and what changed, then continue in existing development tools.

### User jobs

1. **Open existing work.** Open or drop a local project, confirm trust when needed, and see whether the existing Pi setup is usable before starting.
2. **Start or continue a session.** Create a PiLot session or discover an existing CLI session and fork it into PiLot's store before continuation. Rename, stop, resume, and archive PiLot sessions.
3. **Direct coding work.** Prompt with text, files, and images; discover and invoke compatible skills, prompts, and extension commands; choose model and thinking level; steer or queue follow-ups; and stop a run.
4. **Supervise concurrent sessions.** Run sessions in parallel, switch focus without interrupting them, and see Running, Waiting for approval, Waiting for answer, Failed, and Done states. Multiple sessions may target the same project root; PiLot permits this but persistently identifies the shared root and warns that edits may conflict. It does not create worktrees or claim to prevent conflicts.
5. **Handle interruptions safely.** Render Pi extension-defined gates, dialogs, questions, failures, retry/compaction progress, and compatibility blocks natively. PiLot does not invent a universal approval prompt for every tool call.
6. **Inspect and hand off results.** Expand structured tool activity and raw output, inspect read-only last-turn and aggregate workspace diffs, then open files in the user's editor or reveal them in Finder. Editing and Git delivery remain external.
7. **Notice unattended work.** Keep attention states visible in the app and offer opt-in macOS notifications for input needed, failure, or completion only while PiLot is inactive.

### End-to-end workflows

**First open / reopen**

- PiLot detects the existing Pi setup, bundled-engine compatibility, project trust, and actionable resource failures.
- A trusted, compatible project opens directly. Unknown trust or a blocking setup problem gets a native explanation and exact repair action; login, package mutation, and advanced configuration hand off to Pi CLI.
- Reopening restores project and session navigation without replaying in-flight work.

**New coding session**

- The user opens a project, creates a session, confirms the model/thinking choice, adds optional file or image context, and sends a prompt.
- Assistant prose streams in the timeline; routine tool activity is compact, while failures and requests for input are prominent.
- The stable composer remains available for Pi's supported steering and follow-up semantics. Stop is always discoverable as a native command.
- On settlement, the user inspects changed files/diffs and continues in an external editor or Git client.

**Resume existing work**

- PiLot lists its resumable sessions alongside read-only discoverable CLI history.
- Resuming PiLot work reopens its managed session. Continuing CLI history first forks it into PiLot's store according to the existing setup compatibility contract.
- Session-tree editing, fork-from-message, clone-branch, labels, and history export are not part of this workflow.

**Parallel supervision**

- The user starts or resumes several sessions and can switch among them without changing their run state.
- Sidebar and window state expose sessions needing attention. If sessions share a project root, each affected session shows the concurrency warning and peers.
- PiLot neither serializes shared-root work nor performs overlap detection, merge resolution, or workspace isolation. Coordination remains the user's and agents' responsibility.

**Approval or question**

- A compatible Pi extension gate or RPC dialog appears inline near the stable action area and is mirrored in the session's attention state.
- PiLot offers only choices and persistence scopes supplied by Pi or the extension, preserves cancellation/timeout behavior, and distinguishes declining an action from stopping the session.

### Included capability boundary

- Project opening, drag/drop, trust decision, recent projects, and ordinary macOS windows/menus.
- New/resumed/renamed/stopped/archived PiLot sessions and read-only discovery plus forked continuation of CLI sessions.
- Concurrent sessions, explicit attention states, shared-root warnings, and opt-in inactive-app notifications.
- Text, file, and image prompting; compatible skill/prompt/extension command discovery; model/thinking controls; streaming, queues, steering, follow-up, cancellation, retry, and compaction status.
- Native structured rendering for messages, known and generic tools, tool progress/output, extension dialogs/gates, errors, and compatibility diagnostics.
- Read-only last-turn and workspace changed-file/diff inspection with Open in Editor and Reveal in Finder.
- Detect-and-guide setup UI: compatibility summary, project trust, runtime choices needed for work, and precise CLI handoffs for repair.
- Binding native accessibility, keyboard, menu, focus, window-restoration, drag/drop, appearance, and reduced-motion behavior.

### Explicitly deferred

- Broad Pi TUI parity, terminal rendering/scraping, TUI themes/keybindings, arbitrary TUI extension components, and unsupported custom presentation.
- Session tree/branch management, fork-from-message, branch cloning, labels/bookmarks, export/share, and manual history surgery.
- Managed worktrees, automatic isolation, changed-file overlap detection, and conflict prevention or resolution between concurrent sessions.
- Embedded editor, terminal, browser, preview server, or general IDE surface.
- Editing diffs; staging, reverting, committing, branching, merging, rebasing, pushing, and pull-request workflows.
- Native credential/provider/package/extension/skill/prompt management and a comprehensive Pi settings editor.
- A PiLot-wide universal permission system beyond faithfully hosting compatible Pi extension gates.
- First-run onboarding for new Pi users, signing/notarization/update delivery, and non-macOS releases already excluded by the map.

This boundary gives the interaction prototype three concrete walkthroughs to test: complete one coding turn from prompt through external-editor handoff; supervise and answer attention across parallel sessions, including a shared-root warning; and fork then continue an existing CLI session.
