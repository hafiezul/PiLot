# Pi TUI-to-desktop capability matrix

Researched against the official Pi `v0.80.6` package, documentation, examples, and published source on 2026-07-12. Links are pinned to that tag.

## Answer in brief

A native desktop workbench can preserve most **Pi engine semantics**: prompts, streaming, thinking, tools, queues, cancellation, models, compaction, sessions, skills, prompts, extension lifecycle hooks, custom tools, and custom commands. It should not preserve most **terminal presentation semantics**: transcript layout, selectors, editor behavior, TUI components, overlays, themes, or raw key chords.

The practical boundary is:

- **Unchanged** — keep Pi's engine behavior and data contract; render it natively.
- **Adapter** — keep the Pi capability, but translate a documented SDK/RPC event or request into native UI.
- **Redesigned** — preserve the user job, not the terminal interaction or component.
- **Not safely** — do not claim first-release compatibility; the public non-TUI surface is absent, degraded, or would require executing terminal UI inside the desktop.

The most consequential finding is extension compatibility. Backend extension behavior is broad and reusable, but UI compatibility is tiered:

1. lifecycle hooks, provider registration, custom tools, tool gates, commands, and persisted extension state can run unchanged in the Pi engine;
2. `select`/`confirm`/`input`/`editor`, notifications, statuses, text widgets, title, and editor-prefill have a documented RPC UI adapter;
3. arbitrary `ctx.ui.custom()` components, custom editors, headers/footers, working indicators, autocomplete providers, TUI renderers, terminal input, and extension shortcuts do not have a general native-desktop protocol and cannot be promised unchanged.

Pi deliberately has **no built-in permission popup**. Approvals are extension-defined policy implemented by blocking `tool_call` and asking through extension UI. PiLot must therefore host compatible extension dialogs where possible and define its own native approval/activity presentation; it must not imply that every tool call requires approval.

## Classification rules

| Class | Meaning for PiLot |
|---|---|
| **Unchanged** | The same Pi runtime API, state transition, persisted data, or extension hook can be used without changing its meaning. Native pixels are still PiLot's. |
| **Adapter** | A documented structured event/command/request carries the meaning, and PiLot translates it to native controls. |
| **Redesigned** | Pi exposes the underlying operation or data, but its TUI interaction is terminal-specific. PiLot designs a macOS-native equivalent. |
| **Not safely** | No supported non-TUI equivalent exists, RPC explicitly degrades it, or compatibility would require terminal emulation/scraping or private API dependence. |

“Unchanged” never means reusing terminal rendering. The destination explicitly excludes an embedded or scraped TUI.

## Capability matrix

### 1. Conversation, streaming, and run control

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Submit text prompts | **Unchanged** | Call `AgentSession.prompt()` or RPC `prompt`; show the user message in the native transcript. | [SDK], [RPC] |
| Submit image prompts | **Unchanged** | Preserve Pi image content blocks/base64 payloads; use a native attachment picker, paste, and drag/drop UI. | [SDK], [RPC] |
| File arguments and `@file` prompt inclusion | **Redesigned** | Pi's engine accepts prompt content and images, but `@` fuzzy search is an interactive-editor feature. Provide a native file picker/completion and construct the same prompt input. | [Usage], [SDK] |
| Assistant text streaming | **Unchanged** | Consume `message_update` / `text_delta` and update one native message incrementally. | [SDK], [RPC] |
| Thinking streaming and collapse | **Adapter** | Preserve thinking block events and model semantics; present with a native disclosure control and respect `hideThinkingBlock`. | [RPC], [Settings] |
| Tool-call argument streaming | **Adapter** | Correlate `toolcall_start/delta/end` and tool execution events by call id; show native activity rows. | [RPC] |
| Steering messages | **Unchanged** | Preserve Pi's queue semantics: deliver after the current assistant turn finishes its tool calls. | [SDK], [RPC] |
| Follow-up messages | **Unchanged** | Preserve Pi's queue semantics: deliver after the agent has no more work. | [SDK], [RPC] |
| Queue display and dequeue-to-editor | **Adapter** | Consume `queue_update`; render native queued-message chips/list. “Restore to editor” is PiLot UI state, not an engine operation. | [SDK], [RPC], [Usage] |
| One-at-a-time vs all queue modes | **Unchanged** | Use Pi's steering/follow-up mode settings or RPC setters; expose only if the MVP needs it. | [RPC], [Settings] |
| Abort current run | **Unchanged** | Call `session.abort()` or RPC `abort`; show the resulting aborted stop reason. | [SDK], [RPC] |
| Escape-to-abort behavior | **Redesigned** | Bind native Stop and menu command; a raw Escape chord is a TUI convention and may conflict with sheets/popovers. | [Keybindings] |
| Agent idle/completion boundary | **Unchanged** | Treat `agent_settled`, not merely `agent_end`, as final completion after retries, compaction, and queued continuations. | [Extensions], [RPC] |
| Provider errors | **Adapter** | Preserve assistant error messages and stop reasons; present native inline error/retry state. | [RPC] |
| Automatic retry | **Unchanged** | Consume `auto_retry_start/end`, including attempt, delay, and final error; allow abort through Pi. | [RPC], [Settings] |
| Overflow recovery | **Unchanged** | Preserve automatic compaction-and-retry behavior and its events. | [RPC], [Compaction] |
| Manual compaction | **Adapter** | Call SDK/RPC compaction; show native progress and summary result rather than `/compact` UI. | [SDK], [RPC], [Compaction] |
| Context/cost/token status | **Adapter** | Read session stats/context usage and present native status/inspector UI; do not clone the footer. | [SDK], [RPC] |
| Working spinner/message | **Redesigned** | Drive native progress from lifecycle events. TUI working indicators and messages are terminal presentation and are no-ops in RPC. | [Extensions], [RPC] |
| Startup header/footer | **Redesigned** | Distribute project, model, token, resource, and diagnostic information into native navigation/status surfaces. | [Usage], [RPC] |

### 2. Tools, approvals, files, and diffs

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) | **Unchanged** | Let the Pi engine execute the selected tool set; do not reimplement tool semantics in the UI. | [README], [SDK] |
| Tool start/progress/end | **Unchanged** | Consume structured lifecycle events, including accumulated partial results and `isError`. | [SDK], [RPC] |
| Parallel tool execution | **Unchanged** | Correlate by tool call id and tolerate interleaved progress/completion; do not serialize merely for display. | [Extensions] |
| Expand/collapse tool output | **Redesigned** | Use native per-row disclosures and inspectors. Ctrl+O and global TUI expansion are presentation conventions. | [Keybindings], [Extensions] |
| Built-in tool call/result rendering | **Redesigned** | Render known tool result shapes natively. Pi's renderer returns terminal `Component` objects and ANSI-oriented output. | [Extensions], [TUI] |
| Custom tool execution | **Unchanged** | Extension `registerTool()` definitions execute in the Pi engine, including updates, cancellation, errors, details, and persisted results. | [Extensions] |
| Custom tool result data | **Adapter** | Always provide a safe generic view of tool name, arguments, text/image content, details, and error state. Add native rich renderers only for known contracts. | [Extensions], [Session format] |
| Custom tool `renderCall` / `renderResult` | **Not safely** | These return `@earendil-works/pi-tui` components. Do not execute or scrape them as native UI. Fall back to generic rendering. | [Extensions], [TUI] |
| Tool output truncation | **Unchanged** | Preserve Pi's 50 KB/2,000-line tool limits and full-output path metadata; offer native “open full output” where available. | [Extensions], [RPC] |
| Edit diffs | **Adapter** | Use built-in edit result metadata; SDK documents `details.diff` for TUI and standard unified `details.patch` for consumers. Render a native diff. | [SDK] |
| Arbitrary file diffs outside edit results | **Redesigned** | Pi does not provide a universal workspace-diff control plane. Derive workspace/Git changes through explicit native file/Git integration later if selected by MVP scope. | [SDK], [Extensions] |
| Read-file/code output | **Adapter** | Render text with native code styling and file actions; preserve exact tool content/details sent by Pi. | [SDK], [Extensions] |
| Tool images | **Adapter** | Preserve image content blocks and display with native image components. Terminal image protocols are irrelevant. | [TUI], [Session format] |
| User `!command` | **Adapter** | RPC exposes `bash` and `abort_bash`; SDK/extensions expose shell operations. Use a deliberate native command action, not terminal-prefix parsing unless product testing selects it. | [RPC], [Extensions] |
| Hidden `!!command` | **Redesigned** | The user job—run without adding output to model context—may be offered explicitly; do not rely on a hidden punctuation convention. | [Usage], [Session format] |
| User-bash extension interception | **Unchanged** | If the workbench invokes Pi's user-bash path, `user_bash` extensions can replace/wrap execution. A separate host shell would bypass this. | [Extensions] |
| Built-in permission prompts | **Not safely** | None exist. Pi explicitly omits permission popups; no universal approval contract can be inferred. | [README] |
| Extension-defined tool gates | **Adapter** | Preserve `tool_call` blocking/mutation. Host compatible extension confirmation UI and show blocked reasons. | [Extensions], [RPC] |
| Universal pre-tool approval | **Redesigned** | If PiLot adds one, define it as PiLot policy layered around Pi events/extensions, not as existing Pi behavior. Avoid double-prompting extension gates. | [Extensions], [README] |
| Remote/sandbox tool backends | **Unchanged** | Pi tool operation interfaces and overrides remain engine concerns; surface provenance/status natively where known. | [Extensions], [Security] |

### 3. Commands, editor, completion, and clipboard

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Extension commands | **Unchanged** | SDK `prompt()` executes them; RPC `get_commands` lists and `prompt` invokes them. Preserve argument strings and diagnostics. | [SDK], [RPC] |
| Prompt-template commands | **Unchanged** | Keep Pi discovery, expansion, arguments/defaults/slices, and invocation through the engine. | [Prompts], [SDK], [RPC] |
| Skill commands | **Unchanged** | Keep Pi discovery and `/skill:name` expansion through the engine. | [Skills], [SDK], [RPC] |
| Slash-command discovery | **Adapter** | Use `pi.getCommands()`/RPC `get_commands` for extension, prompt, and skill commands; provide native command palette completion. | [Extensions], [RPC] |
| Built-in TUI commands | **Redesigned** | `/model`, `/settings`, `/resume`, `/tree`, etc. are not returned by `get_commands` and do not execute through RPC prompt. Invoke their underlying SDK/RPC operations from native menus/screens. | [Extensions], [RPC] |
| `/copy` | **Redesigned** | Use standard macOS selection and copy commands; optionally provide “Copy last response.” | [Usage] |
| `/export` | **Adapter** | RPC supports HTML export; use a native save panel and reveal/share actions. | [RPC] |
| `/share` | **Redesigned** | Treat sharing as a separate product decision; it is a TUI command, not part of RPC's built-in command list. | [Usage], [RPC] |
| `/reload` | **Adapter** | SDK extension context/runtime and TUI expose reload behavior; a desktop needs an explicit resource reload action and must rebuild/rebind UI subscriptions safely. | [Extensions], [SDK] |
| Multi-line editor | **Redesigned** | Use a native text editor with standard macOS editing, accessibility, undo, and selection. | [Usage], [TUI] |
| External editor | **Redesigned** | Use native “Open in External Editor” behavior and existing `externalEditor` preference where compatible; Ctrl+G is not the contract. | [Usage], [Settings] |
| Path completion | **Redesigned** | Implement native completion if selected; Pi's Tab completion belongs to the TUI editor. | [Usage] |
| `@` fuzzy file completion | **Redesigned** | Preserve the file-reference job with native completion/picker. RPC exposes no TUI autocomplete protocol. | [Usage], [RPC] |
| Extension autocomplete providers | **Not safely** | `addAutocompleteProvider()` is TUI UI context; RPC does not expose an equivalent request stream. | [Extensions], [RPC] |
| Image paste | **Redesigned** | Use native pasteboard and attachment handling; preserve Pi image input data. | [Usage], [SDK] |
| Drag images into editor | **Redesigned** | Use native drag/drop; preserve attachment payload semantics. | [Usage], [SDK] |
| Extension set/paste editor text | **Adapter** | RPC emits `set_editor_text`; `pasteToEditor` degrades to the same behavior. Apply only to the active native composer with clear focus rules. | [RPC] |

### 4. Models, authentication, settings, and trust

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| List available models | **Unchanged** | Use `ModelRegistry`/RPC `get_available_models`; display full provider/model metadata natively. | [SDK], [RPC], [Models] |
| Select model | **Unchanged** | Call SDK/RPC model setters; preserve missing-auth errors and extension `model_select` events. | [SDK], [RPC], [Extensions] |
| Cycle scoped models | **Adapter** | Preserve scoped model semantics if needed, but use native picker/menu actions instead of Ctrl+P. | [README], [Keybindings] |
| Thinking level | **Unchanged** | Use Pi's supported/clamped levels and model-specific mappings; present a native selector. | [SDK], [RPC], [Models] |
| Login/logout | **Redesigned** | Auth capability is supported by Pi managers/CLI, but `/login` is TUI-only and not in RPC's built-in command protocol. Design a native credential/OAuth flow or launch a controlled handoff. | [Usage], [SDK], [RPC] |
| Custom models/providers | **Unchanged** | Load existing `models.json` and extension-registered providers through Pi's registry/resource loader. | [Models], [Extensions], [SDK] |
| Settings values | **Unchanged** | Read/write through `SettingsManager`, preserving global/project merge, queued persistence, `flush()`, and errors. | [Settings], [SDK] |
| `/settings` screen | **Redesigned** | Build native settings UI; `/settings` itself is TUI-only. Do not expose all settings merely because they exist. | [Settings], [RPC] |
| Project trust decision | **Adapter** | Preserve Pi's trust semantics and saved decisions; provide a native decision flow before project resources load. RPC non-interactive mode will not prompt by itself. | [Security], [Usage] |
| Offline/update/telemetry status | **Adapter** | Respect Pi settings/environment and show diagnostics where product-relevant; no need to reproduce startup notices. | [README], [Settings] |

### 5. Sessions, tree navigation, and compaction

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Session discovery/listing | **Unchanged** | Use `SessionManager.list/listAll` or app-managed runtime APIs; render native project/session navigation. | [SDK], [Sessions] |
| Resume/switch session | **Unchanged** | Use `AgentSessionRuntime.switchSession()` or RPC `switch_session`, preserving extension cancellation and runtime replacement. | [SDK], [RPC] |
| New session | **Unchanged** | Use runtime/RPC operation and rebuild subscriptions after replacement. | [SDK], [RPC] |
| Session naming | **Unchanged** | Use Pi session info APIs/RPC; edit with native inline rename. | [RPC], [Session format] |
| Fork from user message | **Unchanged** | Use runtime/RPC fork and Pi entry ids; replace the TUI selector with native history actions. | [SDK], [RPC] |
| Clone active branch | **Unchanged** | Use runtime/RPC clone semantics; expose a native duplicate action. | [SDK], [RPC] |
| Full session tree | **Adapter** | RPC `get_tree`/SDK `SessionManager` expose entries and branches. Render a native outline/timeline, preserving entry ids and active leaf. | [RPC], [Session format] |
| Incremental entry sync | **Unchanged** | RPC `get_entries(since)` provides a durable append cursor and current `leafId`; prefer it to tailing JSONL. | [RPC] |
| `/tree` terminal controls and filters | **Redesigned** | Preserve navigation, labels, filters, and optional branch summary; use native outline search/filter controls. | [Sessions], [Keybindings] |
| Labels/bookmarks | **Unchanged** | Use Pi label entries/APIs; render native bookmarks. | [Extensions], [Session format] |
| Compaction summaries in transcript | **Adapter** | Preserve entries and structured lifecycle; show a native boundary/summary disclosure. | [Compaction], [Session format] |
| Concurrent writing to one session file | **Not safely** | Pi has no same-file interprocess writer lock. One live writer per session file; fork or sequentially hand off. | [Session format], [Runtime research] |
| HTML export | **Adapter** | Use RPC export with a native destination/reveal flow. | [RPC] |

### 6. Extensions and custom UI

| Pi extension surface | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Extension loading/discovery | **Unchanged** | Use Pi's resource loader and trust model; extensions execute with full user permissions. | [Extensions], [SDK], [Security] |
| Lifecycle and agent events | **Unchanged** | Run in the Pi engine: startup, resources, session, input, agent, message, model, provider, tool, compaction, tree, and shutdown hooks. | [Extensions] |
| Input transforms/handling | **Unchanged** | Submit through Pi's prompt path so extension command/input/template/skill ordering remains intact. | [Extensions], [SDK] |
| Context and system-prompt mutation | **Unchanged** | Keep in the engine; the desktop may display diagnostics but must not duplicate transformation logic. | [Extensions] |
| Provider request/response hooks | **Unchanged** | Keep in the engine. Do not proxy provider calls around Pi or hooks will be bypassed. | [Extensions] |
| Tool-call blocking/mutation and result mutation | **Unchanged** | Keep extension middleware order and fail-safe behavior. | [Extensions] |
| Session switch/fork/compact/tree hooks | **Unchanged** | Use Pi runtime operations rather than direct file manipulation so hooks can cancel/customize. | [Extensions], [SDK] |
| Extension custom messages | **Adapter** | Preserve LLM-context participation and `customType`; render generic native cards when no known renderer exists. | [Extensions], [Session format] |
| Extension custom entries | **Adapter** | Preserve non-context state and `customType`; hide or render generic metadata unless PiLot knows the contract. | [Extensions], [Session format] |
| Extension commands | **Unchanged** | Discover/invoke through Pi. Native command palette is an adapter only. | [Extensions], [RPC] |
| Extension dialog `select` | **Adapter** | RPC has a blocking request/response protocol. Show a native choice dialog and respond by id. | [RPC] |
| Extension dialog `confirm` | **Adapter** | RPC has a blocking request/response protocol with timeout/cancel semantics. | [RPC] |
| Extension dialog `input` / `editor` | **Adapter** | RPC supports single/multiline values. Present native sheet/popover/editor and preserve cancellation/timeouts. | [RPC] |
| Extension `notify` | **Adapter** | RPC emits fire-and-forget notification requests; map severity to native in-app notifications, not necessarily system notifications. | [RPC] |
| Extension `setStatus` | **Adapter** | RPC carries keyed status text; map to a native status area with deterministic clearing. | [RPC] |
| Extension text `setWidget` | **Adapter** | RPC carries text lines and placement. Render as a constrained native extension panel; component factories are unsupported. | [RPC] |
| Extension `setTitle` | **Adapter** | RPC carries title text. Apply conservatively to window subtitle/title without violating document naming. | [RPC] |
| Extension editor prefill | **Adapter** | RPC carries editor text. Apply to active composer and protect unsent user edits with a conflict rule. | [RPC] |
| Arbitrary `ctx.ui.custom()` | **Not safely** | RPC returns `undefined`; SDK's default extension UI is no-op unless a Pi run mode binds one. TUI components are not native views. | [RPC], [Extension source] |
| Overlay components | **Not safely** | Overlay layout/focus/lifecycle are terminal component semantics with no desktop protocol. | [TUI], [RPC] |
| Custom editor components | **Not safely** | `setEditorComponent` is a no-op in RPC and requires Pi TUI `CustomEditor`. | [Extensions], [RPC] |
| Custom header/footer | **Not safely** | Component factories and footer data are TUI-specific; setters are no-ops in RPC. | [Extensions], [RPC] |
| Custom working indicator/message | **Not safely** | These are no-ops in RPC; native lifecycle progress replaces them. | [Extensions], [RPC] |
| Direct terminal input subscription | **Not safely** | Terminal key bytes and focus belong to the TUI; do not forward native events as terminal input. | [Extensions], [TUI] |
| Extension shortcuts | **Not safely** | Registration targets TUI key handling and collision rules. PiLot needs a separate future desktop command/keybinding extension contract. | [Extensions], [Keybindings] |
| Extension TUI message/entry renderers | **Not safely** | Renderers return terminal components. Preserve underlying custom message/entry data and use generic native fallback. | [Extensions], [TUI] |
| Extension theme access/switching | **Not safely** | RPC returns no themes and `setTheme` fails. Native app theme is separate. | [RPC], [Themes] |
| Extension autocomplete providers | **Not safely** | They wrap the TUI autocomplete provider; RPC exposes no equivalent. | [Extensions], [RPC] |
| Extension reload | **Adapter** | Preserve shutdown/reload/start lifecycle and invalidate stale contexts; rebuild native subscriptions/state after reload. | [Extensions] |
| Extension/package failures | **Adapter** | Surface resource diagnostics and `extension_error` events in a native diagnostics center without crashing the workbench. | [SDK], [RPC] |

### 7. Skills, prompts, packages, themes, and keybindings

| Pi capability | Class | Desktop representation and boundary | Evidence |
|---|---|---|---|
| Skill discovery and progressive disclosure | **Unchanged** | Keep Pi's global/project/package/CLI discovery and system-prompt metadata behavior. | [Skills], [SDK] |
| Skill invocation | **Unchanged** | Invoke through Pi command expansion so arguments and `disable-model-invocation` behavior remain Pi-owned. | [Skills], [RPC] |
| Prompt discovery and arguments | **Unchanged** | Keep filename commands, frontmatter descriptions/hints, positional/default/slice expansion. | [Prompts] |
| Pi package resource loading | **Unchanged** | Let Pi discover extensions, skills, prompts, and themes according to package manifests/settings. | [Packages], [SDK] |
| Package install/update UI | **Redesigned** | Package management is a separate privileged workflow; do not add it merely to reproduce TUI commands. Stop live runtimes before mutation if later included. | [Packages], [Runtime research] |
| Package/extension security | **Unchanged** | Preserve full-permission execution and project trust. Native presentation must not imply a sandbox. | [Packages], [Security] |
| Theme JSON visual compatibility | **Not safely** | Themes define terminal color tokens and ANSI rendering. Do not promise pixel or component compatibility in AppKit/SwiftUI/web views. | [Themes], [TUI] |
| Theme intent/palette import | **Redesigned** | A future best-effort importer could map semantic colors, but native contrast, materials, light/dark mode, accessibility, and system controls take precedence. | [Themes] |
| Keybinding JSON action semantics | **Redesigned** | Namespaced actions are useful vocabulary, but raw chords and terminal precedence do not map safely to macOS menus, text editing, VoiceOver, or reserved shortcuts. | [Keybindings] |
| Extension-added keybindings | **Not safely** | No supported desktop dispatch protocol exists; ignore with a visible compatibility diagnostic rather than silently pretending support. | [Extensions], [RPC] |
| `/hotkeys` | **Redesigned** | Native menus and a shortcuts/preferences screen are authoritative; built-in TUI command is unavailable over RPC. | [Keybindings], [RPC] |

### 8. TUI component library

| TUI surface | Class | Desktop boundary | Evidence |
|---|---|---|---|
| `Text`, `Box`, `Container`, `Spacer`, `Markdown` | **Not safely** | These render arrays of ANSI terminal lines at a character width. Do not bridge them to native view objects. Re-render source data natively. | [TUI] |
| `Image` terminal component | **Not safely** | It targets Kitty/iTerm2/Ghostty/WezTerm/Warp protocols. Use native image views from the underlying image content. | [TUI] |
| `SelectList`, `SettingsList`, `BorderedLoader` | **Redesigned** | Recreate the interaction with native list, form, progress, and cancellation controls only when the underlying capability is exposed. | [TUI] |
| Custom component `render(width)` | **Not safely** | Character-cell width, ANSI styling, line limits, and invalidation are terminal contracts. | [TUI] |
| `handleInput(data)` / `matchesKey()` | **Not safely** | Raw terminal key sequences are not macOS event/command semantics. | [TUI] |
| Focusable cursor/IME marker | **Not safely** | Native text controls own IME, caret, accessibility, and focus. Do not emulate terminal cursor markers. | [TUI] |
| Overlay anchors/focus/visibility | **Redesigned** | Use native sheets, popovers, sidebars, inspectors, and windows according to the product interaction model. | [TUI] |
| ANSI theme and syntax highlighting | **Redesigned** | Parse/render source content with native attributed text and accessibility-safe colors. | [TUI], [Themes] |
| TUI render caching/invalidation | **Not applicable** | This is implementation guidance for terminal components, not a product capability to port. | [TUI] |

## Extension compatibility contract implied by the evidence

The later **Define existing setup compatibility contract** ticket should use explicit tiers rather than a single “extensions supported” claim:

| Tier | Proposed evidence-based meaning |
|---|---|
| **Engine-compatible** | Extension loads under the app's pinned Pi version and uses lifecycle hooks, providers, custom tools, commands, state, or non-UI middleware. |
| **Desktop-dialog compatible** | In addition, it limits UI to RPC-supported dialog/fire-and-forget methods that PiLot implements. |
| **Generic-fallback compatible** | It emits custom messages/entries or tool data that PiLot can preserve and show generically, while ignoring TUI renderers. |
| **TUI-only / unsupported** | It depends on `ctx.mode === "tui"`, `custom()`, TUI components/renderers, custom editor/header/footer, direct terminal input, TUI autocomplete, themes, or extension shortcuts. |

Detection cannot be perfectly static: extension code can branch dynamically and use arbitrary TypeScript. The safe first-release behavior is runtime observation plus diagnostics:

- report extension load errors from Pi;
- report unsupported/degraded RPC UI requests and no-op categories;
- provide generic custom message/tool rendering;
- never execute TUI renderers in a hidden terminal;
- let extensions that correctly guard on `ctx.mode` degrade themselves;
- offer a troubleshooting view naming the extension source and unsupported surface.

If the embedded SDK is selected instead of RPC, the specification must solve one additional gap: the documented SDK loads extensions, but its default extension UI context is no-op; Pi's built-in interactive and RPC run modes bind concrete UI contexts. A native SDK host therefore needs a supported Pi UI bridge or must accept no-UI extension behavior. Depending on private `ExtensionRunner.setUIContext()` would make the app version-coupled and should not be called a stable public extension contract.

## Product implications

1. **Build on Pi engine events, not terminal output.** SDK and RPC expose enough structured state for a native transcript, activity stream, model controls, queues, compaction, sessions, and native files/diffs.
2. **Treat the TUI as behavioral reference only.** Its editor, selectors, keybindings, overlays, components, themes, headers, and footer are not portable view code.
3. **Make extension compatibility visible and tiered.** “Runs backend logic” and “renders its custom terminal UI” are different promises.
4. **Approvals are policy, not a built-in Pi primitive.** Preserve extension gates, then decide separately whether PiLot adds a native default gate.
5. **Preserve one writer per session file.** Desktop visualization does not change the runtime/state research conclusion.
6. **Prefer generic data fallbacks.** Unknown tools and custom entries should remain inspectable without pretending their TUI renderer is supported.
7. **Native conventions win.** Menus, keyboard commands, text editing, accessibility, sheets, drag/drop, and windowing should express Pi jobs without cloning terminal gestures.

These findings directly unblock **Define existing setup compatibility contract** and **Define MVP workflows and boundaries**, and provide constraints for **Prototype native workbench interactions** and **Choose macOS desktop architecture**.

## Primary sources

- **[README]** [Pi README, modes, interactive features, philosophy, and CLI reference — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/README.md)
- **[Usage]** [Using Pi — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/usage.md)
- **[SDK]** [SDK documentation — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/sdk.md)
- **[RPC]** [RPC protocol and extension UI protocol — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/rpc.md)
- **[Extensions]** [Extension API, lifecycle, tools, rendering, and UI — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/extensions.md)
- **[Extension source]** [Extension runner and no-op UI context — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/extensions/runner.ts)
- **[TUI]** [TUI component API — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/tui.md)
- **[Keybindings]** [Namespaced actions and terminal keybindings — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/keybindings.md)
- **[Themes]** [Terminal theme format and tokens — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/themes.md)
- **[Skills]** [Skill discovery and invocation — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/skills.md)
- **[Prompts]** [Prompt templates and argument expansion — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/prompt-templates.md)
- **[Packages]** [Pi packages and security — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/packages.md)
- **[Models]** [Custom models and provider compatibility — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/models.md)
- **[Settings]** [Settings and project trust — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/settings.md)
- **[Sessions]** [Session workflows and tree navigation — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/sessions.md)
- **[Session format]** [Session JSONL and `SessionManager` — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/session-format.md)
- **[Compaction]** [Compaction and branch summarization — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/compaction.md)
- **[Security]** [Project trust and no built-in sandbox — v0.80.6](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/security.md)
- **[Runtime research]** [Pi runtime and shared-state integration research](pi-runtime-and-shared-state.md)

## Source examples reviewed

The official examples confirm the documented surfaces and degradation boundaries: [`rpc-extension-ui.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/rpc-extension-ui.ts), [`rpc-demo.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/rpc-demo.ts), [`permission-gate.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/permission-gate.ts), [`question.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/question.ts), [`questionnaire.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/questionnaire.ts), [`built-in-tool-renderer.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts), [`message-renderer.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/message-renderer.ts), [`entry-renderer.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/entry-renderer.ts), [`modal-editor.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/modal-editor.ts), and [`overlay-qa-tests.ts`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/overlay-qa-tests.ts).
