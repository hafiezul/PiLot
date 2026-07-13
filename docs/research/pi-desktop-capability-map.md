# Pi Desktop Capability Map

Research baseline: 2026-07-13. The locally installed Pi package reviewed was `@earendil-works/pi-coding-agent` 0.80.6. Product scope decisions are recorded separately in `docs/adr/`.

## Primary sources

- [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi Windows setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)
- [Codex app introduction](https://openai.com/index/introducing-the-codex-app/)
- [Codex worktrees](https://developers.openai.com/codex/app/worktrees)
- [Codex scheduled tasks](https://developers.openai.com/codex/app/automations)

## Integration conclusion

PiLot should embed a pinned Pi SDK in Electron's main process, not bundle or spawn a Pi CLI executable. Pi explicitly supports custom desktop interfaces through `createAgentSession()` and multi-session applications through `createAgentSessionRuntime()`. The in-process SDK preserves typed access to events, tools, models, settings, resources, and sessions without an RPC framing layer. RPC remains useful for non-Node hosts, but adds subprocess lifecycle and JSONL protocol work that Electron does not need.

The embedded SDK can still use the canonical `~/.pi/agent` environment. `AuthStorage.create()`, `ModelRegistry.create()`, `SettingsManager.create()`, `DefaultResourceLoader`, and `SessionManager` default to Pi's standard files and directories. Therefore runtime pinning and CLI environment continuity are independent choices.

## Capability matrix

| Pi capability | SDK surface | Desktop treatment | v1 |
|---|---|---|---|
| Streaming assistant text and thinking | `AgentSession.subscribe()` message events | Native transcript blocks with incremental rendering | Yes |
| Tool calls and streaming results | `tool_execution_start/update/end` | Structured tool rows; accumulated partial output replaces prior output | Yes |
| Prompt, abort, steering, follow-up | `prompt()`, `abort()`, `steer()`, `followUp()` | Composer with explicit Steer/Follow-up mode and visible queues | Yes |
| Multiple active agents | Multiple `AgentSessionRuntime` instances | User-created concurrent tasks with a configurable global run cap | Yes |
| Model selection and thinking | `ModelRegistry`, `setModel()`, `setThinkingLevel()` | Native selectors and command-palette actions | Yes |
| API keys and OAuth | `AuthStorage`, including `login()` callbacks | Shared provider UI for browser auth, device codes, API keys, reauth, and logout | Yes |
| Credential refresh concurrency | Auth file locking in `AuthStorage` | Reuse canonical auth; never copy credentials into an app profile | Yes |
| Global/project agent settings | `SettingsManager` | Shared agent settings; desktop-only preferences stored separately | Yes |
| Project trust | Pi trust services and `trust.json` | Reuse Pi resource trust; ask separately for agent execution consent | Yes |
| Context files | `DefaultResourceLoader` | Load canonical `AGENTS.md`/`CLAUDE.md` context | Yes |
| Skills | `DefaultResourceLoader`, skill commands | Composer completion and invocation; preserve source provenance | Yes |
| Prompt templates | `DefaultResourceLoader`, prompt expansion | Composer completion and invocation | Yes |
| Extensions | Extension runtime | Disabled initially; see hard boundary below | No |
| Pi themes | Terminal color/theme API | Do not translate; use PiLot's system-aware visual system | No |
| Pi keybindings | TUI action/keybinding manager | Recreate semantic desktop actions with native shortcuts | Partial |
| Session persistence | `SessionManager` standard JSONL | A PiLot task uses a standard Pi session | Yes |
| Existing session discovery | `SessionManager.list()` / `listAll()` | Present compatible CLI sessions as tasks automatically | Yes |
| Session tree | `getTree()`, `navigateTree()` | Dedicated graphical history view | Yes |
| Fork and clone | `AgentSessionRuntime.fork()` | Desktop history actions | Yes |
| Labels | `SessionManager` label APIs | Bookmarks in graphical history | Yes |
| Compaction | `compact()`, compaction events | Native action, progress, result, and context-usage feedback | Yes |
| Retry | retry settings and events | Task/run status with abort-retry action | Yes |
| Session naming | runtime/session APIs | Task title, while preserving CLI session naming | Yes |
| Session import/export | runtime import and standard JSONL/HTML facilities | Local JSONL plus readable HTML or Markdown export | Yes |
| Network sharing | CLI GitHub gist flow | Deferred to avoid accidental source or secret disclosure | No |
| User `!` / `!!` Bash | Pi user-Bash execution semantics | Inline command blocks, not a terminal emulator | Yes |
| Full terminal | Not required by agent runtime | Open execution location in user's terminal | No |
| File references | Composer preprocessing and project paths | Fuzzy file attachment/reference UI | Yes |
| Images | `PromptOptions.images` | Paste, drag/drop, and native file picker | Yes |
| Per-edit patch | `edit` result `details.patch` | Inline edit summary and read-only diff | Yes |
| Aggregate changes | Git, outside Pi session API | Read-only task Changes panel with open-in-editor actions | Yes |
| Cost and context usage | assistant usage and session stats | Task header/status details; visible when consequential | Yes |
| Built-in TUI commands | Interactive mode only | Replace with native screens, menus, and command palette | Partial |
| Reload resources | resource/runtime reload | Native Reload Pi Resources action | Yes |
| Startup header/footer | TUI-only presentation | Replace with project/task status surfaces | No direct conversion |

## Extension compatibility boundary

Most extension **behavior** is portable through Pi's runtime: registered tools, event interception, provider registration, commands, session entries, compaction hooks, standard confirmation/input dialogs, notifications, and status values. Pi's RPC mode demonstrates that standard extension UI requests can be translated into a non-terminal protocol.

Arbitrary extension **presentation** is not portable. The following APIs accept or return `@earendil-works/pi-tui` components and terminal key handling, so they cannot be faithfully converted into React controls:

- `ctx.ui.custom()` and terminal overlays
- custom editor components
- custom headers and footers
- component-backed widgets
- custom tool, message, and entry renderers
- TUI themes and direct terminal theme access
- extension shortcuts tied to the terminal keybinding manager

A general TUI-component-to-React adapter would amount to reimplementing Pi's terminal renderer in the desktop app and would still produce terminal UI, violating the product goal. PiLot therefore disables user extensions in v1 rather than claiming partial compatibility. Skills, prompts, context, models, settings, auth, and sessions remain shared.

## Session compatibility and concurrency

Pi session files are append-only JSONL trees with stable entry IDs and `parentId` links. Standard `custom` entries persist namespaced state without entering model context, making them suitable for PiLot task metadata while remaining valid to the CLI.

Pi automatically migrates older session versions, but an older bundled SDK cannot be assumed to understand a future newer schema. PiLot must inspect the header before opening a session, leave unknown versions untouched, and require an app update.

`SessionManager` appends entries but does not provide a cross-process session lease. Auth and settings use file locking; sessions do not expose an equivalent shared lock. PiLot must watch open session files and pause on external changes instead of appending from stale in-memory state. This protects bidirectional CLI continuity without pretending the CLI honors a PiLot lock.

## Codex workflow lessons

OpenAI describes the Codex desktop experience as a command center for multiple agents working in parallel, with threads organized under projects. Its worktree model separates a foreground local checkout from background task worktrees. The useful product lesson is the project/task/execution-location model, not a visual clone.

Codex Handoff is not a thin Git operation. Official documentation describes moving task state and code between Local and Worktree, handling Git branch ownership, applying uncommitted changes, selectively copying ignored files, retaining task-worktree associations, snapshotting before cleanup, and restoring deleted worktrees. PiLot v1 deliberately stops at committed-ref worktrees, branch creation, external IDE/terminal opening, and explicit cleanup.

Scheduled tasks similarly require unattended trust, missed-run policy, background startup, dedicated worktrees, retention, and notification behavior. They are a separate product layer and are deferred until interactive task execution is proven.

## Platform findings

Pi requires Bash on Windows. It checks configured `shellPath`, Git Bash, then `bash.exe` on `PATH`. PiLot should validate and reuse that environment rather than bundle Git/MSYS2 or force WSL.

GUI-launched applications may not inherit terminal-initialized toolchains and API-key variables. PiLot should capture the configured login-shell environment once at startup and support explicit project overrides. Worktree setup remains one optional, trusted project command; PiLot must not infer and execute package installation.

## Deliberate v1 exclusions

- User extensions
- TUI theme or component conversion
- Full integrated terminal
- Inline code editor or IDE shell
- Bidirectional Local/Worktree Handoff
- Dirty-checkout transfer into worktrees
- Automatic worktree eviction or snapshot restoration
- Scheduled or unattended automations
- Child-agent orchestration
- Multiple application windows
- Network transcript sharing
- Automatic installation while releases are unsigned

These exclusions preserve the core desktop value: concurrent graphical Pi tasks, shared Pi continuity, safe worktree isolation, graphical history, and reviewable agent activity.
