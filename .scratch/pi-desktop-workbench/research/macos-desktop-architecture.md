# macOS desktop architecture options

Researched 2026-07-12 against Apple, Pi, Electron, Tauri, and Node primary documentation. This analysis applies the decisions already recorded in [Choose Pi engine sourcing and version strategy](../issues/04-decide-pi-engine-strategy.md), [Define existing setup compatibility contract](../issues/05-define-compatibility-contract.md), and [Prototype native workbench interactions](../issues/07-prototype-workbench-interactions.md).

## Recommendation

Build PiLot as a **SwiftUI-first macOS 14+ app with narrow AppKit adapters**, backed by one supervised, bundled Pi RPC subprocess per live session.

This is the smallest architecture that directly satisfies the binding requirement: native macOS behavior is the product, while Pi remains the engine rather than the presentation layer. SwiftUI already models the selected source-list/detail layout with [`NavigationSplitView`](https://developer.apple.com/documentation/swiftui/navigationsplitview), the toggleable trailing changes pane with the macOS 14+ [`inspector`](https://developer.apple.com/documentation/swiftui/view/inspector(ispresented:content:)), app menus and keyboard commands with [`Commands`](https://developer.apple.com/documentation/swiftui/commands), and restorable project/session windows with [`WindowGroup`](https://developer.apple.com/documentation/swiftui/windowgroup). Standard SwiftUI controls receive baseline accessibility semantics automatically, with explicit modifiers available where the timeline needs richer labels, values, focus, or accessible drag/drop ([Apple accessibility modifiers](https://developer.apple.com/documentation/swiftui/view-accessibility), [accessible controls](https://developer.apple.com/documentation/swiftui/accessible-controls)).

Do not make the whole app AppKit-only. Use [`NSViewRepresentable`](https://developer.apple.com/documentation/swiftui/nsviewrepresentable) only when a measured gap appears—for example, if the rich composer needs `NSTextView` behavior or the long, mixed-height timeline cannot meet scroll/focus performance and accessibility requirements in SwiftUI. This is an escape hatch, not a parallel UI architecture.

## Options

| Option | Native behavior, AX, keyboarding | Pi/process fit | Complexity and maintenance | Decision |
|---|---|---|---|---|
| **SwiftUI + selective AppKit** | Direct use of Apple controls, scenes, menus, focus, drag/drop, and accessibility; AppKit remains available for isolated gaps. | Foundation can launch and supervise the already-selected RPC sidecar directly. | One host language and one UI hierarchy; no browser-to-host IPC layer. | **Choose.** |
| AppKit-only | Maximum control and mature macOS semantics. | Same clean RPC fit. | More imperative window, binding, state, and layout code for a conventional sidebar/detail/inspector app; pays complexity before a SwiftUI gap is known. | Keep as the fallback beneath individual adapters, not the app architecture. |
| Electron | Electron supplies native windows and menus, but renderer UI is HTML/CSS/JS and accessibility follows website/Chromium semantics ([process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)). | TypeScript is close to Pi, but the prior decision still requires one isolated engine per session. Electron therefore adds main/renderer/preload IPC without removing Pi RPC. Electron itself inherits Chromium's multiprocess architecture. | Bundled Chromium/Node plus secure preload bridges and web UI behavior are additional moving parts for a macOS-only native product. | Reject for v1. Its principal advantage would matter if a shared web UI or cross-platform release entered scope. |
| Tauri 2 | Native outer windows and menus, but the workbench itself remains HTML/CSS/JS in WKWebView. Tauri notes that system WebViews introduce platform differences ([process model](https://v2.tauri.app/concept/process-model/)). | Official sidecars can bundle and stream an external executable ([sidecar docs](https://v2.tauri.app/develop/sidecar/)). | Adds Rust core↔WebView IPC and Rust↔Pi sidecar plumbing, leaving Swift/AppKit work for native gaps. Its small system-WebView distribution is not the binding goal. | Reject for v1. Reconsider for a cross-platform destination. |

Framework identity is not the reason for the choice. The choice follows from the selected interaction model and first-release platform. Both web-shell alternatives are viable, but each inserts a web presentation boundary exactly where native behavior is binding.

## Process and ownership boundaries

```text
PiLot.app (one native app process)
├─ SwiftUI/AppKit presentation (main actor)
├─ app coordinator and app-owned project/session index
├─ session controller actor A ─ stdio JSONL ─ Pi RPC process A ─ Pi session JSONL A
├─ session controller actor B ─ stdio JSONL ─ Pi RPC process B ─ Pi session JSONL B
└─ compatibility/setup discovery (never a second writer to a live session)
```

### Native app process

The app owns windows, menus, keyboard commands, drag/drop, accessibility, project navigation, session supervision, native dialogs, the compatibility summary, and the read-only diff inspector. Pi events are converted into immutable UI state before reaching the main actor; parsing, pipe reads, and process waits never run on the main actor.

Keep the data flow concrete:

- one `SessionController` actor owns one child `Process`, its three pipes, request IDs, pending responses, and the strict LF-delimited receive buffer;
- one main-actor session view model exposes presentation state for that controller;
- one app coordinator owns project/session identity and controller lifetimes.

No generic plugin bus, local HTTP server, embedded browser, XPC service, or database is required for this boundary. Pi RPC is already the supported isolation protocol, and Pi's session JSONL remains the canonical transcript. App-owned recovery metadata is addressed by [Define state recovery and migration behavior](../issues/11-define-state-recovery-and-migration.md).

### Pi engine processes

Launch the pinned engine directly with Foundation [`Process`](https://developer.apple.com/documentation/foundation/process/run(_:arguments:terminationhandler:)) and `Pipe`/`FileHandle`; Apple documents asynchronous pipe reads via [`readabilityHandler`](https://developer.apple.com/documentation/foundation/filehandle/readabilityhandler). Do not involve the user's `pi`, `node`, `npm`, PATH lookup, Terminal, PTY, or shell in engine launch.

Each process receives:

- the project directory as `cwd`;
- an explicit PiLot-owned session path;
- the selected project-trust override only after the native trust decision;
- the resolved startup environment;
- bundle-relative paths to the matching Node executable and pinned Pi CLI entry point;
- `--mode rpc` and only the arguments owned by the session controller.

Pi documents RPC as JSON objects over stdin/stdout, one record per LF, with correlated responses, streaming events, and extension UI requests ([Pi RPC documentation](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/rpc.md)). The parser must therefore split on byte `0x0A`, retain incomplete UTF-8 bytes until a complete record arrives, decode each JSON object, correlate responses by ID, and treat stdout as protocol-only. Stderr is a separate, redacted, bounded diagnostic stream.

### Bundled runtime

Package the tested Pi production dependency tree and a Node runtime inside `PiLot.app/Contents/Resources/PiEngine`; make no network or package-manager call at runtime. Pi v0.80.6 requires Node `>=22.19.0` ([Pi package manifest](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/package.json)). Node publishes separate official macOS arm64 and x64 archives and checksums for 22.19.0 ([release index](https://nodejs.org/download/release/v22.19.0/), [SHA-256 list](https://nodejs.org/download/release/v22.19.0/SHASUMS256.txt)); universal PiLot builds should include both and select the executable matching the running app architecture. Build automation verifies the lockfile and upstream checksums. Updating Node or Pi is a PiLot release operation, never an in-app mutation.

This increases the DMG size, but avoids an installer, dependence on the user's CLI, and silent runtime drift. Signing and notarization can later cover the same app/resource layout without changing the runtime boundary.

### Startup environment

A Finder-launched app cannot assume the same environment as an interactive Pi CLI. Resolve it once per app launch, before starting session engines:

1. Start with the app's inherited environment.
2. Best-effort capture the existing user's login-shell environment with an absolute, validated shell path and a fixed command that emits a marker followed by `/usr/bin/env -0`; run it from the user's home directory with a short timeout and no project-controlled interpolation.
3. Merge the captured values, but remove process-injection variables that can alter the bundled runtime (`DYLD_*`, `NODE_OPTIONS`, and `NODE_PATH`) and overwrite PiLot-owned launch values.
4. If capture fails or times out, continue with the inherited environment and surface one compatibility diagnostic; missing provider credentials follow the existing compatibility contract rather than blocking the whole app.

The shell is used only to read the familiar login environment, never to launch Pi. This preserves common `PATH` and provider-variable setups while keeping the engine executable and arguments deterministic. The exact warning and consent language belongs to [Define trust, security, and unsigned distribution](../issues/09-define-trust-and-distribution.md).

## Failure containment and lifecycle

A Pi engine and its trusted extensions run with the user's permissions. The process boundary contains crashes and stale in-memory state; it is **not a security sandbox**.

- **Engine exit:** reject that controller's pending RPC requests, preserve the session file, mark only that session interrupted, retain redacted stderr and termination status, and offer explicit restart. Never replay the in-flight prompt automatically.
- **Malformed protocol or incompatible version:** stop only that controller and show a compatibility diagnostic. Do not guess at unknown events or continue after stream desynchronization.
- **Blocked extension dialog:** keep it pinned through the native extension-UI adapter; closing a window does not silently answer it.
- **Normal stop:** when active, request abort; then close stdin so RPC performs session shutdown, wait briefly, terminate the root process if needed, and record an unclean stop. Pi's RPC process treats stdin EOF as shutdown, so app crashes also release the pipe and normally tear down the engine.
- **App launch recovery:** do not infer that a previous prompt completed from app-owned UI state. Reconcile against persisted Pi entries and the rules selected by the recovery ticket.
- **Resource reload or session replacement:** replace the entire controller/process after the engine settles rather than hot-swapping resources into a live runtime, matching the existing compatibility decision.

Do not add an XPC helper or custom daemon in v1. They would not reduce Pi's required filesystem/tool permissions, and RPC already gives each session a restartable crash boundary. Add a stronger process-tree supervisor only if testing shows extension/tool descendants survive normal RPC shutdown often enough to be a product problem.

## UI implementation constraints

- Use a value-keyed `WindowGroup` so each project/session window has native restoration identity; keep process liveness out of SwiftUI restoration state.
- Use `NavigationSplitView` for the project/session source list and focused narrative, and `inspector` for the user-toggleable changes pane selected in the prototype.
- Express File, Edit, View, Session, and Window actions through SwiftUI `Commands`, with focus-scoped command targets so menus and keyboard shortcuts act on the active session.
- Use standard `List`, `Button`, `TextField`/text editing, split views, menus, alerts, and sheets before custom drawing. Add explicit accessibility labels, values, live progress semantics, and focus transitions for streamed messages, tool activity, and pinned interruptions.
- Use native file URLs and `Transferable`/drag-drop APIs for project and file drops; validate paths at the trust boundary.
- Virtualize the timeline and coalesce streaming deltas before publishing UI updates. If profiling or VoiceOver testing exposes a SwiftUI limitation, replace only that surface with an AppKit adapter.
- Render diffs and code as native text in v1. Syntax highlighting may use attributed strings; do not introduce a web view solely for code rendering.

## Validation gates for implementation planning

The architecture is chosen, but implementation must prove its binding qualities before broad feature work:

1. A native shell spike reproduces the selected navigator, focused timeline, composer, pinned interruption, and toggleable inspector on macOS 14.
2. VoiceOver can identify and traverse projects, session attention states, narrative items, tool states, approval controls, composer, and diff hunks without relying on color or hover.
3. Every primary action is reachable through normal focus traversal and a visible menu command; text editing keeps standard macOS behavior.
4. A representative long session streams without blocking typing or losing scroll position, and multiple simultaneous engine processes do not block the main actor.
5. Killing one engine leaves other sessions and windows responsive; restart never duplicates an in-flight prompt.
6. Both arm64 and x64 packaged builds launch the bundled engine without installed Node or Pi.

A failed gate changes the narrow implementation (including an AppKit adapter), not the overall native-host/RPC architecture unless evidence shows the boundary itself is the cause.
